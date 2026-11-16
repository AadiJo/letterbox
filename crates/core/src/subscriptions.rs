//! Commits and the updates they send. `commit` is the only way the world changes,
//! and after each one `flush` sends every subscription whose answer changed, then
//! starts loading the bodies a subscribed conversation shows.

use std::rc::Rc;

use letterbox_protocol::{
    AccountErrorReason, AccountId, AccountStatus, Body, CoreMessage, MessageId, Query, Rev, SignInOption, Unavailable,
};

use crate::maps::{HashMap, HashSet};
use crate::store::Transaction;
use crate::views::{Live, evaluate};
use crate::world::{AccountRecord, Health, MessageRecord, World, messages_of};
use crate::{Inner, Linked, State};

/// What a view needs from outside the world while the core answers it.
struct LiveState<'a> {
    syncing: &'a HashSet<AccountId>,
    unreachable_bodies: &'a HashSet<MessageId>,
    adapters: &'a HashMap<AccountId, Linked>,
    options: &'a [SignInOption],
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
}

impl Inner {
    /// Sends an update to every subscription whose answer changed, then starts loading bodies someone is looking at.
    pub(crate) fn flush(self: &Rc<Self>) {
        let rev = self.store.rev();
        let mut fetches = Vec::new();
        {
            let mut state = self.state.borrow_mut();
            let State {
                world,
                adapters,
                subscriptions,
                syncing,
                loading_bodies,
                unreachable_bodies,
                ..
            } = &mut *state;
            let live = LiveState {
                syncing: &*syncing,
                unreachable_bodies: &*unreachable_bodies,
                adapters: &*adapters,
                options: &self.options,
            };
            for (sub, entry) in subscriptions.iter_mut() {
                let update = evaluate(world, &entry.query, &live);
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
        }
        for (account_id, id) in fetches {
            self.background(&account_id, Rc::clone(self).fetch_body(id));
        }
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
