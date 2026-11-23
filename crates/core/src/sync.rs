//! The sync pass. A pass pushes an account's pending changes to the provider (push.rs), pulls
//! what changed there, or one snapshot page (see snapshot.rs), and records how it went.
//! It runs in the account's queue, and stops writing once a sign-out or a new sign-in
//! takes the account (`still_current`). Bodies load here too, one fetch per message
//! someone is looking at. A change set's new mail that makes it the user's turn is told
//! after its commit (notify.rs).

use std::rc::Rc;

use letterbox_protocol::{AccountId, Answer, Empty, MessageId, RequestId, Response, SyncNowError};

use tokio::sync::oneshot;

use crate::adapter::{AdapterFailure, ChangesResult};
use crate::reconcile::{Incoming, reconcile};
use crate::snapshot::Pulled;
use crate::world::{AccountRecord, Health, MessageRecord, put_account, put_message};
use crate::{Inner, Linked, State};

pub(crate) type PassResult = Result<(), AdapterFailure>;

/// How an account's pulls have ended since the core started (see `note_pull`).
#[derive(Clone, Copy, Default)]
pub(crate) struct PullsEnded {
    /// How many have ended well.
    pub(crate) well: u64,
    /// True when the last one found the provider offline.
    pub(crate) offline: bool,
}

/// Whether a pass pulls, and whether the accounts view shows it as syncing.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Pull {
    /// It only pushes, unless a change it carries needs a pull first (push.rs).
    No,
    /// It pulls and shows syncing: a sign-in's, a sync-now's, a backfill page's.
    Shown,
    /// It pulls and shows syncing only once the pull lists a snapshot: the schedule's routine
    /// pull (schedule.rs), which mostly finds nothing new and should not move a UI each time.
    Quiet,
}

/// What a sync-now's or the schedule's pass hands back from the queue: how the pass ended (None when a
/// backfill held the pull), the wait for the backfill it left or found running, and
/// whether it resumed a snapshot saved before the request, whose cursor is then older.
pub(crate) type Joined = (Option<PassResult>, Option<oneshot::Receiver<PassResult>>, bool);

impl Inner {
    pub(crate) async fn fetch_body(self: Rc<Self>, id: MessageId) {
        let found = {
            let state = self.state.borrow();
            state.world.messages.get(&id).and_then(|record| {
                let linked = state.adapters.get(&record.account_id)?;
                Some((Rc::clone(&linked.adapter), record.provider_ref()?.clone()))
            })
        };
        let Some((adapter, r#ref)) = found else {
            self.state.borrow_mut().loading_bodies.remove(&id);
            return;
        };
        let result = adapter.body(r#ref).await;
        let current = {
            let mut state = self.state.borrow_mut();
            state.loading_bodies.remove(&id);
            state.world.messages.get(&id).cloned()
        };
        let Some(current) = current else { return };
        match result {
            Err(_) => {
                self.state.borrow_mut().unreachable_bodies.insert(id);
                self.commit(|_, _, _| {});
            }
            Ok(body) => {
                // Processed here, in the fetch's own job, so it is stored ready (body/mod.rs).
                let reading = self.processed_now(&body, current.reading.clone());
                self.commit(|world, tx, _| {
                    put_message(
                        world,
                        tx,
                        MessageRecord {
                            body: Some(body),
                            reading,
                            ..current
                        },
                    );
                });
            }
        }
    }

    /// True while `linked` still serves the account. A sign-out unlinks it and a new sign-in
    /// links another. A pass checks this after every provider call and writes nothing once
    /// it is false, so it cannot bring back records a sign-out deleted, or overwrite the
    /// status a sign-out or sign-in set.
    pub(crate) fn still_current(&self, account_id: &AccountId, linked: &Linked) -> bool {
        let state = self.state.borrow();
        state
            .adapters
            .get(account_id)
            .is_some_and(|current| current.link == linked.link)
    }

    /// Fetches what changed at the provider. Lists one snapshot page instead while a snapshot
    /// is under way, or when there is no cursor or it expired. A quiet pull shows syncing then.
    async fn pull(
        self: &Rc<Self>,
        account_id: &AccountId,
        linked: &Linked,
        pull: Pull,
    ) -> Result<Pulled, AdapterFailure> {
        let adapter = &linked.adapter;
        let cursor = self
            .state
            .borrow()
            .world
            .accounts
            .get(account_id)
            .filter(|account| account.snapshot.is_none())
            .and_then(|account| account.cursor.clone());
        if let Some(cursor) = cursor
            && let ChangesResult::Changes(set) = adapter.changes(cursor).await?
        {
            if !self.still_current(account_id, linked) {
                return Ok(Pulled::Done);
            }
            let arrivals = self.arrivals(account_id, &set);
            let mut arrived = None;
            let rev = self.commit(|world, tx, at| {
                let Some(account) = world.accounts.get(account_id).cloned() else {
                    return;
                };
                let incoming = Incoming {
                    page_of: None,
                    mailboxes: set.mailboxes,
                    added: set.added,
                    updated: set.updated,
                    removed: set.removed,
                };
                arrived = Some(reconcile(world, tx, account_id, incoming, at));
                let cursor = Some(set.cursor);
                put_account(world, tx, AccountRecord { cursor, ..account });
            });
            if let Some(arrived) = arrived {
                self.announce(arrived, rev);
            }
            self.tell_your_turns(account_id, arrivals);
            return Ok(Pulled::Done);
        }
        if !self.still_current(account_id, linked) {
            return Ok(Pulled::Done);
        }
        self.caught_up_by_snapshot(account_id);
        if pull == Pull::Quiet && self.state.borrow_mut().syncing.insert(account_id.clone()) {
            self.commit(|_, _, _| {});
        }
        self.snapshot_page(account_id, linked).await
    }

    /// One sync pass: push what is pending, then pull when asked, then record how it went.
    /// None when it was asked to pull while a backfill is queued: the backfill's pages do the
    /// pulling, and the pass leaves no trace, so a sync-now that waits for the backfill and
    /// runs again does the same work whether it was queued before a page job or after it.
    pub(crate) async fn pass(self: Rc<Self>, account_id: AccountId, pull: Pull) -> Option<PassResult> {
        let with_pull = pull != Pull::No;
        let adapter = {
            let state = self.state.borrow();
            let known = state.world.accounts.contains_key(&account_id);
            state.adapters.get(&account_id).filter(|_| known).cloned()
        };
        let Some(linked) = adapter else {
            return Some(Ok(()));
        };
        if with_pull && self.backfilling(&account_id) {
            return None;
        }
        if pull == Pull::Shown {
            self.state.borrow_mut().syncing.insert(account_id.clone());
            self.commit(|_, _, _| {});
        }
        // While the provider has not confirmed what a change did (push.rs), a pass pulls first.
        // Once a pull brings the core in step with the provider (a change set, or a snapshot's
        // last page, a backfill's included), `confirm` settles each change whose answer never
        // came from what the provider holds, and the push may carry the changes after it on
        // the same messages: their refs are current again. Until then the push passes them by.
        let mut result = Ok(());
        let mut pulled = None;
        if self.unsure(&account_id) && !self.backfilling(&account_id) {
            // A pass that only pushes was not counted as a pull when it was queued. It is one now.
            let _pulling = self.pulling(&account_id);
            let done = self.pull(&account_id, &linked, pull).await;
            self.note_pull(&account_id, done.as_ref().map(drop).map_err(|failure| *failure));
            match done {
                Ok(done) => pulled = Some(done),
                Err(failure) => result = Err(failure),
            }
        }
        let caught_up = |done: &Pulled| matches!(done, Pulled::Done) && self.still_current(&account_id, &linked);
        if pulled.as_ref().is_some_and(caught_up) {
            self.confirm(&account_id);
        }
        if result.is_ok() {
            let refreshed = !self.unsure(&account_id);
            result = self.push(&account_id, &linked, refreshed).await;
        }
        // Synced once the core is in step with the provider, which a backfill is only at its
        // last page. A pass that pulled first pulls no more: a snapshot's next page is queued.
        let mut synced = false;
        if result.is_ok() && with_pull {
            let pulled_now = pulled.is_none();
            let done = match pulled {
                Some(done) => Ok(done),
                None => self.pull(&account_id, &linked, pull).await.inspect(|done| {
                    if caught_up(done) {
                        self.confirm(&account_id);
                    }
                }),
            };
            // A pull that ran here, not the one the pass made before its push.
            if pulled_now {
                self.note_pull(&account_id, done.as_ref().map(drop).map_err(|failure| *failure));
            }
            match done {
                Ok(done) => synced = matches!(done, Pulled::Done),
                Err(failure) => result = Err(failure),
            }
        }
        let shown = self.state.borrow_mut().syncing.remove(&account_id);
        if !self.still_current(&account_id, &linked) {
            // A sign-out or a new sign-in took the account while this pass ran, and its
            // records are theirs now. Only show that this pass stopped syncing.
            if shown {
                self.commit(|_, _, _| {});
            }
            return Some(result);
        }

        self.record_outcome(&account_id, result, synced, with_pull);
        Some(result)
    }

    /// Notes in `pulls_ended` how a pull for the account ended. The schedule reads it
    /// (schedule.rs): to skip its own pull when another ended well since its tick, and to tell
    /// whether a hint that the network is back holds.
    fn note_pull(&self, account_id: &AccountId, ended: PassResult) {
        let mut state = self.state.borrow_mut();
        let log = state.pulls_ended.entry(account_id.clone()).or_default();
        log.well += u64::from(ended.is_ok());
        log.offline = ended == Err(AdapterFailure::Offline);
    }

    /// How the account's pulls have ended since the core started.
    pub(crate) fn pulls_ended(&self, account_id: &AccountId) -> PullsEnded {
        self.state
            .borrow()
            .pulls_ended
            .get(account_id)
            .copied()
            .unwrap_or_default()
    }

    /// Records how a pass or an outbox check (confirm.rs) that still serves the account ended:
    /// its health from `result`, and the time it synced when `synced`. Writes only when the
    /// health changed, unless `pulled` says a sync ran and the status must show it ended.
    /// Health that clears wakes the account's sync schedule, which pulls at once (schedule.rs).
    pub(crate) fn record_outcome(
        self: &Rc<Self>,
        account_id: &AccountId,
        result: PassResult,
        synced: bool,
        pulled: bool,
    ) {
        let account = self.state.borrow().world.accounts.get(account_id).cloned();
        let Some(account) = account else {
            return;
        };
        if synced {
            let mut state = self.state.borrow_mut();
            let State {
                world,
                unreachable_bodies,
                ..
            } = &mut *state;
            unreachable_bodies.retain(|id| {
                world
                    .messages
                    .get(id)
                    .is_none_or(|record| &record.account_id != account_id)
            });
        }
        let health = Health::from(result);
        if health == Health::Ok
            && account.health != Health::Ok
            && let Some(linked) = self.state.borrow().adapters.get(account_id)
        {
            linked.wake.notify_waiters();
        }
        if pulled || health != account.health {
            self.commit(|world, tx, _| {
                let last_synced_at = if synced {
                    Some(self.env.now())
                } else {
                    account.last_synced_at.clone()
                };
                put_account(
                    world,
                    tx,
                    AccountRecord {
                        health,
                        last_synced_at,
                        ..account
                    },
                );
            });
        }
    }

    /// A pass that pulls, for a sync-now, a sign-in or the schedule. It joins the backfill the
    /// pass left or found running while it is still in the queue, so the backfill cannot end unseen.
    pub(crate) async fn sync_pass(self: Rc<Self>, account_id: AccountId, pull: Pull) -> Joined {
        // Only a linked account can resume. One signed out with its mail kept still holds its
        // saved snapshot, but no pass can move it on, so following up for it would never end.
        let resumed = {
            let state = self.state.borrow();
            let account = state.world.accounts.get(&account_id);
            state.adapters.contains_key(&account_id) && account.is_some_and(|account| account.snapshot.is_some())
        };
        let ran = Rc::clone(&self).pass(account_id.clone(), pull).await;
        (ran, self.join_backfill(&account_id), resumed)
    }

    /// Syncs each account in turn and answers once all have finished, a backfill included,
    /// plus one pass after a backfill, so the answer covers what the provider held when the
    /// request came, even when the backfill's cursor is older. The first pass is queued before this returns, so it runs ahead of anything the
    /// client sends after this request.
    pub(crate) fn sync_now(self: &Rc<Self>, id: RequestId, account_id: Option<AccountId>) {
        let accounts: Vec<AccountId> = match account_id {
            Some(account_id) => vec![account_id],
            None => self.state.borrow().world.accounts.keys().cloned().collect(),
        };
        let mut accounts = accounts.into_iter();
        let start = |core: &Rc<Self>, account_id: AccountId| {
            let pass = core.enqueue_pull(&account_id, Rc::clone(core).sync_pass(account_id.clone(), Pull::Shown));
            (account_id, pass)
        };
        let mut next = accounts.next().map(|account_id| start(self, account_id));
        let core = Rc::clone(self);
        self.work.spawn_local(async move {
            let mut offline = false;
            while let Some((account_id, mut pass)) = next {
                let result = loop {
                    let (ran, backfill, resumed) = pass
                        .await
                        .expect("a queued pass runs to its end, since a panic ends the program");
                    let ended = match backfill {
                        Some(end) => end.await.ok(),
                        None => None,
                    };
                    match (ran, ended) {
                        // A snapshot ended well, but its cursor can be older than this request:
                        // its backfill was queued earlier, or this pass resumed one saved before
                        // the request. Pass once more, so the answer covers what the provider
                        // held when it was asked.
                        (_, Some(Ok(()))) => pass = start(&core, account_id.clone()).1,
                        (Some(Ok(())), None) if resumed => pass = start(&core, account_id.clone()).1,
                        (Some(result), ended) => break ended.unwrap_or(result),
                        // A backfill held the pull and ended in a failure. Run the pass now.
                        (None, _) => pass = start(&core, account_id.clone()).1,
                    }
                };
                offline |= result == Err(AdapterFailure::Offline);
                next = accounts.next().map(|account_id| start(&core, account_id));
            }
            let answer = if offline {
                Err(SyncNowError::Offline)
            } else {
                Ok(Empty {})
            };
            core.respond(id, Response::SyncNow(Answer::from(answer)));
        });
    }
}
