//! The sync pass. A pass pushes an account's pending changes to the provider, pulls
//! what changed there, and records how it went. It runs in the account's queue, and
//! stops writing once a sign-out or a new sign-in takes the account (`still_current`).
//! Bodies load here too, one fetch per message someone is looking at.

use std::rc::Rc;

use letterbox_protocol::{
    AccountId, Answer, ChangeResult, CoreMessage, Empty, MessageId, Refusal, RequestId, Response, SyncNowError,
};

use crate::adapter::{AdapterFailure, ApplyResult, ChangesResult};
use crate::changes::{overlay, plan};
use crate::reconcile::{Incoming, reconcile};
use crate::world::{
    AccountRecord, ChangeOutcome, ChangeRecord, Health, MessageRecord, put_account, put_change, put_message,
};
use crate::{Inner, Linked, State};

pub(crate) type PassResult = Result<(), AdapterFailure>;

impl Inner {
    pub(crate) async fn fetch_body(self: Rc<Self>, id: MessageId) {
        let found = {
            let state = self.state.borrow();
            state.world.messages.get(&id).and_then(|record| {
                let linked = state.adapters.get(&record.account_id)?;
                Some((Rc::clone(&linked.adapter), record.r#ref.clone()))
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

    fn settle(self: &Rc<Self>, change: ChangeRecord, result: ChangeResult) {
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
    fn still_current(&self, account_id: &AccountId, linked: &Linked) -> bool {
        let state = self.state.borrow();
        state
            .adapters
            .get(account_id)
            .is_some_and(|current| current.link == linked.link)
    }

    /// Carries every pending change for one account to the provider, oldest first. Stops when the provider is unreachable.
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
                                let r#ref = moved
                                    .iter()
                                    .find(|pair| pair.from == record.r#ref)
                                    .map_or_else(|| record.r#ref.clone(), |pair| pair.to.clone());
                                let server = overlay(&record.server, &step.part, id);
                                put_message(
                                    world,
                                    tx,
                                    MessageRecord {
                                        r#ref,
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

    /// Fetches what changed at the provider. Falls back to a full snapshot when there is no cursor or it expired.
    async fn pull(self: &Rc<Self>, account_id: &AccountId, linked: &Linked) -> PassResult {
        let adapter = &linked.adapter;
        let cursor = self
            .state
            .borrow()
            .world
            .accounts
            .get(account_id)
            .and_then(|account| account.cursor.clone());
        if let Some(cursor) = cursor
            && let ChangesResult::Changes(set) = adapter.changes(cursor).await?
        {
            if !self.still_current(account_id, linked) {
                return Ok(());
            }
            self.commit(|world, tx, _| {
                let Some(account) = world.accounts.get(account_id).cloned() else {
                    return;
                };
                let incoming = Incoming {
                    full: false,
                    mailboxes: set.mailboxes,
                    added: set.added,
                    updated: set.updated,
                    removed: set.removed,
                };
                reconcile(world, tx, account_id, incoming);
                let cursor = Some(set.cursor);
                put_account(world, tx, AccountRecord { cursor, ..account });
            });
            return Ok(());
        }

        let mut messages = Vec::new();
        let mut page = None;
        loop {
            let result = adapter.snapshot(page.take()).await?;
            if !self.still_current(account_id, linked) {
                return Ok(());
            }
            messages.extend(result.messages);
            if let Some(next) = result.next {
                page = Some(next);
                continue;
            }
            self.commit(|world, tx, _| {
                let Some(account) = world.accounts.get(account_id).cloned() else {
                    return;
                };
                let incoming = Incoming {
                    full: true,
                    mailboxes: Some(result.mailboxes),
                    added: messages,
                    updated: Vec::new(),
                    removed: Vec::new(),
                };
                reconcile(world, tx, account_id, incoming);
                put_account(
                    world,
                    tx,
                    AccountRecord {
                        cursor: result.cursor,
                        ..account
                    },
                );
            });
            return Ok(());
        }
    }

    /// One sync pass: push what is pending, then pull when asked, then record how it went.
    pub(crate) async fn pass(self: Rc<Self>, account_id: AccountId, with_pull: bool) -> PassResult {
        let adapter = {
            let state = self.state.borrow();
            let known = state.world.accounts.contains_key(&account_id);
            state.adapters.get(&account_id).filter(|_| known).cloned()
        };
        let Some(linked) = adapter else { return Ok(()) };
        if with_pull {
            self.state.borrow_mut().syncing.insert(account_id.clone());
            self.commit(|_, _, _| {});
        }
        let mut result = self.push(&account_id, &linked).await;
        if result.is_ok() && with_pull {
            result = self.pull(&account_id, &linked).await;
        }
        self.state.borrow_mut().syncing.remove(&account_id);
        if !self.still_current(&account_id, &linked) {
            // A sign-out or a new sign-in took the account while this pass ran, and its
            // records are theirs now. Only show that this pass stopped syncing.
            if with_pull {
                self.commit(|_, _, _| {});
            }
            return result;
        }

        let account = self.state.borrow().world.accounts.get(&account_id).cloned();
        let Some(account) = account else { return result };
        let synced = result.is_ok() && with_pull;
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
        result
    }

    /// Syncs each account in turn and answers once all have finished. The first
    /// pass is queued before this returns, so it runs ahead of anything the
    /// client sends after this request.
    pub(crate) fn sync_now(self: &Rc<Self>, id: RequestId, account_id: Option<AccountId>) {
        let accounts: Vec<AccountId> = match account_id {
            Some(account_id) => vec![account_id],
            None => self.state.borrow().world.accounts.keys().cloned().collect(),
        };
        let mut accounts = accounts.into_iter();
        let start = |core: &Rc<Self>, account_id: AccountId| {
            core.enqueue(&account_id, Rc::clone(core).pass(account_id.clone(), true))
        };
        let mut next = accounts.next().map(|account_id| start(self, account_id));
        let core = Rc::clone(self);
        self.work.spawn_local(async move {
            let mut offline = false;
            while let Some(pass) = next {
                let result = pass
                    .await
                    .expect("a queued pass runs to its end, since a panic ends the program");
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
