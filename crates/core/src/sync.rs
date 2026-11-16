//! The sync pass. A pass pushes an account's pending changes to the provider, pulls
//! what changed there, or one snapshot page (see snapshot.rs), and records how it went.
//! It runs in the account's queue, and stops writing once a sign-out or a new sign-in
//! takes the account (`still_current`). Bodies load here too, one fetch per message
//! someone is looking at.

use std::rc::Rc;

use letterbox_protocol::{
    AccountId, Answer, ChangeResult, CoreMessage, Empty, MessageId, Refusal, RequestId, Response, SyncNowError,
};

use tokio::sync::oneshot;

use crate::adapter::{AdapterFailure, ApplyResult, ChangesResult};
use crate::changes::{overlay, plan};
use crate::reconcile::{Incoming, reconcile};
use crate::snapshot::Pulled;
use crate::world::{
    AccountRecord, ChangeOutcome, ChangeRecord, Health, MessageRecord, Op, Origin, put_account, put_change, put_message,
};
use crate::{Inner, Linked, State};

pub(crate) type PassResult = Result<(), AdapterFailure>;

/// What a sync-now's pass hands back from the queue: how the pass ended (None when a
/// backfill held the pull), the wait for the backfill it left or found running, and
/// whether it resumed a snapshot saved before the request, whose cursor is then older.
type Joined = (Option<PassResult>, Option<oneshot::Receiver<PassResult>>, bool);

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
                self.commit(|world, tx, _| {
                    put_message(
                        world,
                        tx,
                        MessageRecord {
                            body: Some(body),
                            ..current
                        },
                    );
                });
            }
        }
    }

    pub(crate) fn settle(self: &Rc<Self>, change: ChangeRecord, result: ChangeResult) {
        let id = change.id.clone();
        let rev = self.commit(|world, tx, at| {
            put_change(
                world,
                tx,
                ChangeRecord {
                    outcome: Some(ChangeOutcome { rev: at, result }),
                    ..change
                },
            );
        });
        self.send(CoreMessage::Settled {
            change: id,
            rev,
            result,
        });
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

    /// Carries every pending change for one account to the provider, oldest first. A send
    /// still in its undo window is passed by (see outbox.rs). Stops when the provider is unreachable.
    async fn push(self: &Rc<Self>, account_id: &AccountId, linked: &Linked) -> PassResult {
        let adapter = &linked.adapter;
        let waiting: Vec<ChangeRecord> = self
            .state
            .borrow()
            .world
            .changes
            .values()
            .filter(|change| &change.account_id == account_id && change.outcome.is_none())
            .cloned()
            .collect();
        for change in waiting {
            if !self.still_current(account_id, linked) {
                return Ok(());
            }
            let Some(op) = change.op.clone() else { continue };
            if let Op::Send(outbound) = op {
                self.deliver(account_id, linked, change, outbound).await?;
                continue;
            }
            let planned = plan(&self.state.borrow().world, &op);
            let Some(steps) = planned else {
                self.settle(change, ChangeResult::Failed(Refusal::UnknownTarget));
                continue;
            };
            let mut refused = None;
            for step in steps {
                let outcome = adapter.apply(step.mutation).await?;
                if !self.still_current(account_id, linked) {
                    return Ok(());
                }
                match outcome {
                    ApplyResult::Refused { reason } => {
                        refused = Some(reason);
                        break;
                    }
                    ApplyResult::Applied { moved } => {
                        // The provider now holds this part of the change, so it becomes part of what the provider reported.
                        self.commit(|world, tx, _| {
                            for id in &step.message_ids {
                                let Some(record) = world.messages.get(id).cloned() else {
                                    continue;
                                };
                                let Some(old) = record.provider_ref().cloned() else {
                                    continue;
                                };
                                let r#ref = moved
                                    .iter()
                                    .find(|pair| pair.from == old)
                                    .map_or(old, |pair| pair.to.clone());
                                let server = overlay(&record.server, &step.part, id);
                                put_message(
                                    world,
                                    tx,
                                    MessageRecord {
                                        origin: Origin::Provider { r#ref },
                                        server,
                                        ..record
                                    },
                                );
                            }
                        });
                    }
                }
            }
            let result = refused.map_or(ChangeResult::Done, |reason| ChangeResult::Failed(reason.into()));
            self.settle(change, result);
        }
        Ok(())
    }

    /// Fetches what changed at the provider. Lists one snapshot page instead while a snapshot
    /// is under way, or when there is no cursor or it expired.
    async fn pull(self: &Rc<Self>, account_id: &AccountId, linked: &Linked) -> Result<Pulled, AdapterFailure> {
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
            return Ok(Pulled::Done);
        }
        if !self.still_current(account_id, linked) {
            return Ok(Pulled::Done);
        }
        self.snapshot_page(account_id, linked).await
    }

    /// One sync pass: push what is pending, then pull when asked, then record how it went.
    /// None when it was asked to pull while a backfill is queued: the backfill's pages do the
    /// pulling, and the pass leaves no trace, so a sync-now that waits for the backfill and
    /// runs again does the same work whether it was queued before a page job or after it.
    pub(crate) async fn pass(self: Rc<Self>, account_id: AccountId, with_pull: bool) -> Option<PassResult> {
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
        if with_pull {
            self.state.borrow_mut().syncing.insert(account_id.clone());
            self.commit(|_, _, _| {});
        }
        let mut result = self.push(&account_id, &linked).await;
        // Synced once the core is in step with the provider, which a backfill is only at its last page.
        let mut synced = false;
        if result.is_ok() && with_pull {
            match self.pull(&account_id, &linked).await {
                Ok(pulled) => synced = matches!(pulled, Pulled::Done),
                Err(failure) => result = Err(failure),
            }
        }
        self.state.borrow_mut().syncing.remove(&account_id);
        if !self.still_current(&account_id, &linked) {
            // A sign-out or a new sign-in took the account while this pass ran, and its
            // records are theirs now. Only show that this pass stopped syncing.
            if with_pull {
                self.commit(|_, _, _| {});
            }
            return Some(result);
        }

        let account = self.state.borrow().world.accounts.get(&account_id).cloned();
        let Some(account) = account else {
            return Some(result);
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
                    .is_none_or(|record| record.account_id != account_id)
            });
        }
        let health = Health::from(result);
        if with_pull || health != account.health {
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
        Some(result)
    }

    /// A sync-now's pass. It joins the backfill the pass left or found running while it is
    /// still in the queue, so the backfill cannot end unseen.
    async fn sync_pass(self: Rc<Self>, account_id: AccountId) -> Joined {
        // Only a linked account can resume. One signed out with its mail kept still holds its
        // saved snapshot, but no pass can move it on, so following up for it would never end.
        let resumed = {
            let state = self.state.borrow();
            let account = state.world.accounts.get(&account_id);
            state.adapters.contains_key(&account_id) && account.is_some_and(|account| account.snapshot.is_some())
        };
        let ran = Rc::clone(&self).pass(account_id.clone(), true).await;
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
            let pass = core.enqueue(&account_id, Rc::clone(core).sync_pass(account_id.clone()));
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
