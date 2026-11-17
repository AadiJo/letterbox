//! One subscription's view, kept between commits. It decides whether a commit could change
//! the subscription's answer, from what `Rows::refresh` rebuilt, and only then is the
//! answer built again (see `flush` in subscriptions.rs).
//!
//! A thread list that filters on `retired` also changes with time alone. Its index holds
//! every thread that passes the rest of its filter, newest first, so the conversations
//! RETIRED_AFTER old or more are its tail, and the list answers with one side of the cut
//! the clock puts there. `wakes_at` says when the next thread crosses the cut, and flush
//! books a wake for then, so a conversation moves while the app runs.

use std::cmp::Reverse;
use std::collections::BTreeSet;
use std::collections::btree_set::Range;

use chrono::TimeDelta;
use letterbox_protocol::{AccountId, Body, Query, ThreadFilter, ThreadId, ThreadSummary, Time, Update};

use crate::clock::{iso, parse};
use crate::rows::{Refresh, Rows};
use crate::senders::{Senders, zone_of};
use crate::views::{Live, accounts, mailboxes, matches, missing_bodies, page, thread};
use crate::work::Meter;
use crate::world::World;

/// How long a conversation waits before it retires from a list that filters `retired: false`
/// into one that filters `retired: true`: from Your turn into Let go?.
pub const RETIRED_AFTER: TimeDelta = TimeDelta::days(30);

/// Where a thread sorts in a list: newest message first, then by id.
pub type Place = (Reverse<Time>, ThreadId);

pub enum LiveView {
    Accounts,
    SignInOptions,
    Mailboxes {
        account_id: Option<AccountId>,
    },
    Threads {
        filter: ThreadFilter,
        offset: u64,
        limit: u64,
        /// Every thread that passes the filter apart from `retired`, in list order.
        listed: BTreeSet<Place>,
        /// For a list that filters `retired`: the first place past the cut, as of the last catch-up.
        edge: Option<Place>,
    },
    Thread {
        thread_id: ThreadId,
        /// What the last answer showed for each of its messages that has no stored body.
        missing: Vec<Body>,
    },
    Senders(Box<Senders>),
}

pub fn place(summary: &ThreadSummary) -> Place {
    (Reverse(summary.last_message_at.clone()), summary.id.clone())
}

/// The cut at `now`: every place before it is newer than RETIRED_AFTER, every place at or
/// after it is as old or older. No thread id is empty, so none sorts before the cut's.
fn cut(now: &Time) -> Place {
    let at = parse(now);
    #[expect(clippy::disallowed_methods, reason = "a bound to search by, never sent or stored")]
    let before_every_id = ThreadId::minted("");
    (
        Reverse(iso(at.checked_sub_signed(RETIRED_AFTER).unwrap_or(at))),
        before_every_id,
    )
}

/// The part of `listed` a list shows: all of it, or the side of the cut that `retired` asks for.
fn window<'a>(listed: &'a BTreeSet<Place>, retired: Option<bool>, live: &dyn Live) -> Range<'a, Place> {
    match retired {
        None => listed.range::<Place, _>(..),
        Some(true) => listed.range(cut(&live.now())..),
        Some(false) => listed.range(..cut(&live.now())),
    }
}

/// The first place past the cut, for a list that filters `retired`.
fn edge_of(listed: &BTreeSet<Place>, filter: &ThreadFilter, live: &dyn Live) -> Option<Place> {
    filter.retired?;
    window(listed, Some(true), live).next().cloned()
}

/// Every thread that passes `filter`. Reads every row, so only a new list or a full refresh calls it.
fn listing(filter: &ThreadFilter, rows: &Rows, meter: &Meter) -> BTreeSet<Place> {
    rows.all()
        .filter(|listed| {
            meter.matched();
            matches(listed, filter)
        })
        .map(|listed| place(&listed.summary))
        .collect()
}

impl LiveView {
    /// The view for a new subscription. Call it with rows that are up to date.
    pub fn open(query: &Query, world: &World, rows: &Rows, live: &dyn Live, meter: &Meter) -> LiveView {
        match query {
            Query::Accounts => LiveView::Accounts,
            Query::SignInOptions => LiveView::SignInOptions,
            Query::Mailboxes { account_id } => LiveView::Mailboxes {
                account_id: account_id.clone(),
            },
            Query::Threads { filter, offset, limit } => {
                let listed = listing(filter, rows, meter);
                LiveView::Threads {
                    edge: edge_of(&listed, filter, live),
                    filter: filter.clone(),
                    offset: *offset,
                    limit: limit.get(),
                    listed,
                }
            }
            Query::Thread { thread_id } => LiveView::Thread {
                thread_id: thread_id.clone(),
                missing: missing_bodies(world, thread_id, live),
            },
            Query::Senders {
                account_id,
                mailbox_id,
                zone,
                offset,
                limit,
            } => {
                let filter = ThreadFilter {
                    account_id: account_id.clone(),
                    mailbox_id: mailbox_id.clone(),
                    ..ThreadFilter::default()
                };
                LiveView::Senders(Box::new(Senders::open(
                    filter,
                    zone_of(zone.as_deref()),
                    (*offset, limit.get()),
                    rows,
                    live,
                    meter,
                )))
            }
        }
    }

    /// Brings the view up to date with a refresh. True when its answer could have changed.
    /// The accounts and mailboxes views read only small tables and what is in flight, so
    /// they always answer again. The caller sends an answer only if it differs from the last.
    pub fn catch_up(&mut self, refresh: &Refresh, world: &World, rows: &Rows, live: &dyn Live, meter: &Meter) -> bool {
        match self {
            LiveView::Accounts | LiveView::SignInOptions | LiveView::Mailboxes { .. } => true,
            LiveView::Threads {
                filter, listed, edge, ..
            } => {
                let changed = match refresh {
                    Refresh::Everything => {
                        *listed = listing(filter, rows, meter);
                        *edge = edge_of(listed, filter, live);
                        return true;
                    }
                    Refresh::Threads { changed, .. } => changed,
                };
                let mut moved = false;
                for one in changed {
                    if let Some(before) = &one.before {
                        moved |= listed.remove(&place(&before.summary));
                    }
                    if let Some(after) = rows.listed(&one.id) {
                        meter.matched();
                        if matches(after, filter) {
                            listed.insert(place(&after.summary));
                            moved = true;
                        }
                    }
                }
                if cfg!(test) {
                    assert!(
                        *listed == listing(filter, rows, &Meter::default()),
                        "a thread list's index differs from one built afresh from the rows"
                    );
                }
                // Time alone moves the cut: then a thread crossed it.
                let now = edge_of(listed, filter, live);
                moved |= now != *edge;
                *edge = now;
                moved
            }
            LiveView::Thread { thread_id, missing } => {
                let touched = match refresh {
                    Refresh::Everything => true,
                    Refresh::Threads { touched, .. } => touched.contains(thread_id),
                };
                let now = missing_bodies(world, thread_id, live);
                let loading_changed = now != *missing;
                *missing = now;
                touched || loading_changed
            }
            LiveView::Senders(senders) => senders.catch_up(refresh, rows, live, meter),
        }
    }

    /// True for a query whose answer moves with time alone, which reads the time (see
    /// subscriptions.rs): a list that splits on age, and Updates, whose days move on at midnight.
    pub fn splits_on_age(query: &Query) -> bool {
        matches!(query, Query::Threads { filter, .. } if filter.retired.is_some())
            || matches!(query, Query::Senders { .. })
    }

    /// When the next thread crosses this list's cut, for a list that filters `retired`: when
    /// the oldest thread on the newer side turns RETIRED_AFTER old. For Updates, the next
    /// midnight, when its days move on. None for any other view.
    pub fn wakes_at(&self, live: &dyn Live) -> Option<Time> {
        if let LiveView::Senders(senders) = self {
            return senders.wakes_at();
        }
        let LiveView::Threads { filter, listed, .. } = self else {
            return None;
        };
        filter.retired?;
        let (Reverse(oldest), _) = window(listed, Some(false), live).next_back()?;
        let at = parse(oldest);
        Some(iso(at.checked_add_signed(RETIRED_AFTER).unwrap_or(at)))
    }

    /// The view's answer from the world and the rows as they are now.
    pub fn answer(&self, world: &World, rows: &Rows, live: &dyn Live) -> Update {
        match self {
            LiveView::Accounts => Update::Accounts {
                data: accounts(world, live),
            },
            LiveView::SignInOptions => Update::SignInOptions {
                data: live.options().to_vec(),
            },
            LiveView::Mailboxes { account_id } => Update::Mailboxes {
                data: mailboxes(world, rows, account_id.as_ref()),
            },
            LiveView::Threads {
                filter,
                offset,
                limit,
                listed,
                ..
            } => {
                let shown = window(listed, filter.retired, live);
                // Counting one side of the cut walks it. A list with no cut knows its length.
                let total = match filter.retired {
                    None => listed.len(),
                    Some(_) => shown.clone().count(),
                };
                Update::Threads {
                    data: page(rows, shown.map(|(_, id)| id), total, *offset, *limit),
                }
            }
            LiveView::Thread { thread_id, .. } => Update::Thread {
                data: thread(world, rows, thread_id, live),
            },
            LiveView::Senders(senders) => Update::Senders {
                data: senders.answer(rows),
            },
        }
    }
}
