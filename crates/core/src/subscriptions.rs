//! Commits and the updates they send. `commit` is the only way the world changes,
//! and after each one `flush` rebuilds the rows the commit touched (see rows.rs), answers
//! again every subscription whose view says the commit could change its answer (see
//! live_view.rs), sends the answers that did change, then starts loading the bodies a
//! subscribed conversation shows. A list that splits on age changes with time alone, so
//! flush also books a wake for when the next conversation crosses (`book_wake`).
//!
//! Such a list reads the time from `State::views_now`, which the clock sets only when one
//! opens and when a wake runs. No conversation crosses between two wakes, since one is booked
//! for each crossing, and the real clock's wait reads the wall clock every minute, so a suspend
//! or a clock set forward or back ends it on time. The commits in between need not read the clock. A fixed clock moves
//! on every read, so reading it per commit would move it too, under the scenarios' feet.

use std::rc::Rc;

use letterbox_protocol::{
    AccountErrorReason, AccountId, AccountStatus, Body, CoreMessage, MessageId, Query, Rev, SignInOption,
    SubscriptionId, Time, Unavailable,
};
use tokio::task::spawn_local;

use crate::clock::parse;
use crate::live_view::LiveView;
use crate::maps::{HashMap, HashSet};
use crate::store::Transaction;
use crate::views::Live;
use crate::world::{AccountRecord, Health, MessageRecord, World, messages_of};
use crate::{Inner, Linked, State, Subscription};

/// What a view needs from outside the world while the core answers it.
struct LiveState<'a> {
    syncing: &'a HashSet<AccountId>,
    unreachable_bodies: &'a HashSet<MessageId>,
    adapters: &'a HashMap<AccountId, Linked>,
    options: &'a [SignInOption],
    /// The time as the views last read it (see the module docs).
    now: &'a Time,
}

impl Live for LiveState<'_> {
    /// Syncing while a pass pulls, and between the pages of a snapshot. `done` counts the
    /// messages the snapshot has listed so far. The total is not known until it ends.
    fn status(&self, account: &AccountRecord) -> AccountStatus {
        let syncing = AccountStatus::Syncing {
            done: account.snapshot.as_ref().map_or(0, |progress| progress.listed),
            total: None,
            last_synced_at: account.last_synced_at.clone(),
        };
        if self.syncing.contains(&account.id) {
            return syncing;
        }
        let last_synced_at = account.last_synced_at.clone();
        match account.health {
            Health::Ok => match last_synced_at {
                Some(last_synced_at) if account.snapshot.is_none() => AccountStatus::Idle { last_synced_at },
                _ => syncing,
            },
            Health::Offline => AccountStatus::Offline { last_synced_at },
            Health::NeedsSignIn => AccountStatus::NeedsSignIn,
            Health::ProviderError => AccountStatus::Error {
                reason: AccountErrorReason::Provider,
                last_synced_at,
            },
        }
    }

    fn missing_body(&self, record: &MessageRecord) -> Body {
        if self.unreachable_bodies.contains(&record.id) || !self.adapters.contains_key(&record.account_id) {
            Body::Unavailable {
                reason: Unavailable::Offline,
            }
        } else {
            Body::Loading
        }
    }

    fn options(&self) -> &[SignInOption] {
        self.options
    }

    fn now(&self) -> Time {
        self.now.clone()
    }
}

impl Inner {
    /// Adds a subscription and sends its first answer.
    pub(crate) fn subscribe(self: &Rc<Self>, sub: SubscriptionId, query: Query) {
        let subscription = Subscription {
            query,
            view: None,
            sent: String::new(),
        };
        self.state.borrow_mut().subscriptions.insert(sub, subscription);
        self.flush();
    }

    /// Sends an update to every subscription whose answer changed, then starts loading bodies someone is looking at.
    pub(crate) fn flush(self: &Rc<Self>) {
        let rev = self.store.rev();
        let mut fetches = Vec::new();
        let wake = {
            let mut state = self.state.borrow_mut();
            let State {
                world,
                rows,
                people,
                adapters,
                subscriptions,
                syncing,
                loading_bodies,
                unreachable_bodies,
                views_now,
                ..
            } = &mut *state;
            let mut opening = subscriptions.values().filter(|entry| entry.view.is_none());
            if opening.any(|entry| LiveView::splits_on_age(&entry.query)) {
                *views_now = self.env.now();
            }
            let live = LiveState {
                syncing: &*syncing,
                unreachable_bodies: &*unreachable_bodies,
                adapters: &*adapters,
                options: &self.options,
                now: &*views_now,
            };
            let touched = world.take_touched();
            let refresh = rows.refresh(world, touched, &self.meter);
            people.refresh(world, &refresh);
            for (sub, entry) in subscriptions.iter_mut() {
                let view = match &mut entry.view {
                    Some(view) => {
                        if !view.catch_up(&refresh, world, rows, people, &live, &self.meter) {
                            continue;
                        }
                        view
                    }
                    None => entry
                        .view
                        .insert(LiveView::open(&entry.query, world, rows, people, &live, &self.meter)),
                };
                let update = view.answer(world, rows, &live);
                let text = serde_json::to_string(&update).expect("updates are plain data");
                if text == entry.sent {
                    continue;
                }
                entry.sent = text;
                self.send(CoreMessage::Update {
                    sub: sub.clone(),
                    rev,
                    update,
                });
            }
            for entry in subscriptions.values() {
                let Query::Thread { thread_id } = &entry.query else {
                    continue;
                };
                for record in messages_of(world, thread_id) {
                    if record.body.is_some()
                        || loading_bodies.contains(&record.id)
                        || unreachable_bodies.contains(&record.id)
                        || !adapters.contains_key(&record.account_id)
                    {
                        continue;
                    }
                    loading_bodies.insert(record.id.clone());
                    fetches.push((record.account_id.clone(), record.id.clone()));
                }
            }
            let views = subscriptions.values().filter_map(|entry| entry.view.as_ref());
            views.filter_map(|view| view.wakes_at(&live)).min_by_key(parse)
        };
        if let Some(at) = wake {
            self.book_wake(at);
        }
        for (account_id, id) in fetches {
            self.background(&account_id, Rc::clone(self).fetch_body(id));
        }
    }

    /// Flushes again at `at`, when a conversation crosses a list's cut (see live_view.rs), unless
    /// a wake at or before `at` is booked already. A later wake is booked when that one runs.
    /// It also runs early if the clock is set back before `views_now`, which the lists' cut was
    /// worked out from (see `until_or_back` in clock.rs). Like a send's undo window, the wait is
    /// not work the core finishes before it closes.
    fn book_wake(self: &Rc<Self>, at: Time) {
        let since = {
            let mut state = self.state.borrow_mut();
            if state.wake_at.as_ref().is_some_and(|booked| parse(booked) <= parse(&at)) {
                return;
            }
            state.wake_at = Some(at.clone());
            state.views_now.clone()
        };
        let wait = self.env.until_or_back(&at, &since);
        let core = Rc::clone(self);
        spawn_local(async move {
            wait.await;
            if core.work.is_closed() {
                return;
            }
            {
                let mut state = core.state.borrow_mut();
                if state.wake_at.as_ref() == Some(&at) {
                    state.wake_at = None;
                }
                state.views_now = core.env.now();
            }
            core.flush();
        });
    }

    /// The only way the world changes.
    pub(crate) fn commit(self: &Rc<Self>, work: impl FnOnce(&mut World, &Transaction<'_>, Rev)) -> Rev {
        self.commit_then(work, |_| {})
    }

    /// Like `commit`. `announce` runs after the write and before the updates, which is where `accepted` goes.
    pub(crate) fn commit_then(
        self: &Rc<Self>,
        work: impl FnOnce(&mut World, &Transaction<'_>, Rev),
        announce: impl FnOnce(Rev),
    ) -> Rev {
        let rev = {
            let mut state = self.state.borrow_mut();
            let world = &mut state.world;
            self.store.write(|tx, at| work(world, tx, at))
        };
        announce(rev);
        self.flush();
        rev
    }
}
