//! One subscription's view, kept between commits. It decides whether a commit could change
//! the subscription's answer, from what `Rows::refresh` rebuilt, and only then is the
//! answer built again (see `flush` in subscriptions.rs).

use std::cmp::Reverse;
use std::collections::BTreeSet;

use letterbox_protocol::{AccountId, Body, Query, ThreadFilter, ThreadId, ThreadSummary, Time, Update};

use crate::rows::{Refresh, Rows};
use crate::views::{Live, accounts, mailboxes, matches, missing_bodies, page, thread};
use crate::work::Meter;
use crate::world::World;

/// Where a thread sorts in a list: newest message first, then by id.
type Place = (Reverse<Time>, ThreadId);

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
        /// Every thread that passes the filter, in list order.
        listed: BTreeSet<Place>,
    },
    Thread {
        thread_id: ThreadId,
        /// What the last answer showed for each of its messages that has no stored body.
        missing: Vec<Body>,
    },
}

fn place(summary: &ThreadSummary) -> Place {
    (Reverse(summary.last_message_at.clone()), summary.id.clone())
}

/// Every thread that passes `filter`. Reads every row, so only a new list or a full refresh calls it.
fn listing(filter: &ThreadFilter, rows: &Rows, meter: &Meter) -> BTreeSet<Place> {
    rows.summaries()
        .filter(|summary| {
            meter.matched();
            matches(summary, filter)
        })
        .map(place)
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
            Query::Threads { filter, offset, limit } => LiveView::Threads {
                filter: filter.clone(),
                offset: *offset,
                limit: limit.get(),
                listed: listing(filter, rows, meter),
            },
            Query::Thread { thread_id } => LiveView::Thread {
                thread_id: thread_id.clone(),
                missing: missing_bodies(world, thread_id, live),
            },
        }
    }

    /// Brings the view up to date with a refresh. True when its answer could have changed.
    /// The accounts and mailboxes views read only small tables and what is in flight, so
    /// they always answer again. The caller sends an answer only if it differs from the last.
    pub fn catch_up(&mut self, refresh: &Refresh, world: &World, rows: &Rows, live: &dyn Live, meter: &Meter) -> bool {
        match self {
            LiveView::Accounts | LiveView::SignInOptions | LiveView::Mailboxes { .. } => true,
            LiveView::Threads { filter, listed, .. } => {
                let changed = match refresh {
                    Refresh::Everything => {
                        *listed = listing(filter, rows, meter);
                        return true;
                    }
                    Refresh::Threads { changed, .. } => changed,
                };
                let mut moved = false;
                for one in changed {
                    if let Some(before) = &one.before {
                        moved |= listed.remove(&place(before));
                    }
                    if let Some(after) = rows.summary(&one.id) {
                        meter.matched();
                        if matches(after, filter) {
                            listed.insert(place(after));
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
        }
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
                offset, limit, listed, ..
            } => Update::Threads {
                data: page(rows, listed.iter().map(|(_, id)| id), listed.len(), *offset, *limit),
            },
            LiveView::Thread { thread_id, .. } => Update::Thread {
                data: thread(world, rows, thread_id, live),
            },
        }
    }
}
