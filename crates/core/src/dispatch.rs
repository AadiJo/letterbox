//! Message dispatch. `receive` decodes each client message and hands it to the part
//! of the core that owns it: subscriptions, commands (`on_command`) or requests
//! (`on_request`). Everything the core sends goes out through `send`.

use std::rc::Rc;

use letterbox_protocol::{
    AccountId, Answer, BlobError, ChangeId, ChangeResult, ClientMessage, Command, CoreMessage, PROTOCOL,
    ProtocolErrorReason, Refusal, Request, RequestId, Response, Rev, ThreadId, Turn,
};

use crate::Inner;
use crate::changes::{Edit, mode_of, resolve, targets};
use crate::effect::{Effect, MessageEffect, TurnEffect};
use crate::world::{ChangeOutcome, ChangeRecord, Op, ThreadRecord, put_change, put_thread};

impl Inner {
    pub(crate) fn send(&self, message: CoreMessage) {
        (self.send)(message);
    }

    pub(crate) fn accepted(&self, change: &ChangeId, rev: Rev) {
        self.send(CoreMessage::Accepted {
            change: change.clone(),
            rev,
        });
    }

    /// Refuses the command behind `change`, which leaves no trace.
    pub(crate) fn reject(&self, change: ChangeId, reason: Refusal) {
        self.send(CoreMessage::Rejected {
            change,
            reason,
            conflict: None,
        });
    }

    pub(crate) fn respond(&self, id: RequestId, response: Response) {
        self.send(CoreMessage::Response { id, response });
    }

    fn on_command(self: &Rc<Self>, change: ChangeId, command: Command) {
        let earlier = self.state.borrow().world.changes.get(&change).cloned();
        if let Some(earlier) = earlier {
            self.send(CoreMessage::Accepted {
                change: change.clone(),
                rev: earlier.accepted_rev,
            });
            if let Some(outcome) = earlier.outcome {
                self.send(CoreMessage::Settled {
                    change,
                    rev: outcome.rev,
                    result: outcome.result,
                });
            }
            return;
        }
        if let Command::SetTurn { thread_ids, turn } = &command {
            let target = targets(&self.state.borrow().world, thread_ids);
            return match target {
                Ok(target) => {
                    let sets: Vec<_> = target.thread_ids.into_iter().map(|id| (id, turn.fixed())).collect();
                    self.set_turns(change, target.account_id, &sets, None)
                }
                Err(reason) => self.reject(change, reason),
            };
        }

        let Some((thread_ids, edit)) = Edit::of(&command) else {
            // Set-turn was answered above. Sends belong to the outbox, and undos to undo.rs.
            return match &command {
                Command::Send { draft } => self.send_draft(change, draft),
                Command::Undo { change: target } => self.undo(change, target),
                _ => self.reject(change, Refusal::NotSupported),
            };
        };
        let resolved = resolve(&self.state.borrow().world, thread_ids, edit);
        match resolved {
            Ok((account_id, op)) => self.accept_messages(change, account_id, vec![op], None),
            Err(reason) => self.reject(change, reason),
        }
    }

    /// Accepts a turn correction, which sets each thread's turn to its value, and settles it
    /// at once: it never leaves the device. `undoes` names the change it reverses, for an undo.
    pub(crate) fn set_turns(
        self: &Rc<Self>,
        change: ChangeId,
        account_id: AccountId,
        sets: &[(ThreadId, Option<Turn>)],
        undoes: Option<ChangeId>,
    ) {
        let effect = TurnEffect::new(&self.state.borrow().world, sets, undoes);
        let rev = self.commit_then(
            |world, tx, at| {
                for (id, turn_override) in sets {
                    if let Some(thread) = world.threads.get(id).cloned() {
                        let turn_override = *turn_override;
                        put_thread(
                            world,
                            tx,
                            ThreadRecord {
                                turn_override,
                                ..thread
                            },
                        );
                    }
                }
                put_change(
                    world,
                    tx,
                    ChangeRecord {
                        id: change.clone(),
                        account_id: account_id.clone(),
                        effect: Effect::Turns(effect),
                        accepted_rev: at,
                        outcome: Some(ChangeOutcome {
                            rev: at,
                            result: ChangeResult::Done,
                        }),
                    },
                );
            },
            |rev| self.accepted(&change, rev),
        );
        self.send(CoreMessage::Settled {
            change,
            rev,
            result: ChangeResult::Done,
        });
    }

    /// Accepts a change to flags or mailboxes and queues a pass to carry it to the provider.
    /// One that alters nothing, as an undo of a change that altered nothing, is done at once.
    /// `undoes` names the change it reverses, for an undo.
    pub(crate) fn accept_messages(
        self: &Rc<Self>,
        change: ChangeId,
        account_id: AccountId,
        ops: Vec<Op>,
        undoes: Option<ChangeId>,
    ) {
        let effect = {
            let state = self.state.borrow();
            let account = state.world.accounts.get(&account_id);
            account.map(|account| Effect::Messages(MessageEffect::new(&state.world, mode_of(account), &ops, undoes)))
        };
        let Some(effect) = effect else {
            return self.reject(change, Refusal::UnknownTarget);
        };
        // A change that alters nothing does nothing (effect.rs), so it is done at once.
        let nothing = effect.ops().is_empty();
        let rev = self.commit_then(
            |world, tx, at| {
                let done = ChangeOutcome {
                    rev: at,
                    result: ChangeResult::Done,
                };
                put_change(
                    world,
                    tx,
                    ChangeRecord {
                        id: change.clone(),
                        account_id: account_id.clone(),
                        effect,
                        accepted_rev: at,
                        outcome: nothing.then_some(done),
                    },
                );
            },
            |rev| self.accepted(&change, rev),
        );
        if nothing {
            let result = ChangeResult::Done;
            return self.send(CoreMessage::Settled { change, rev, result });
        }
        self.background(&account_id, Rc::clone(self).pass(account_id.clone(), false));
    }

    fn on_request(self: &Rc<Self>, id: RequestId, request: Request) {
        match request {
            Request::SignIn { option, password } => self.sign_in(id, option, password),
            Request::SignOut {
                account_id,
                delete_local_mail,
            } => self.sign_out(id, account_id, delete_local_mail),
            Request::SyncNow { account_id } => self.sync_now(id, account_id),
            Request::Blob { .. } => self.respond(id, Response::Blob(Answer::from(Err(BlobError::NotSupported)))),
        }
    }

    pub(crate) fn receive(self: &Rc<Self>, value: serde_json::Value) {
        assert!(
            self.state.try_borrow_mut().is_ok(),
            "Core::receive was called from inside CoreOptions::send. Queue the message and call \
             receive after send returns."
        );
        let message = match serde_json::from_value::<ClientMessage>(value) {
            Ok(message) => message,
            Err(error) => {
                return self.send(CoreMessage::ProtocolError {
                    reason: ProtocolErrorReason::Malformed,
                    detail: error.to_string(),
                });
            }
        };
        match message {
            ClientMessage::Hello { protocol } => {
                if protocol != f64::from(PROTOCOL) {
                    return self.send(CoreMessage::ProtocolError {
                        reason: ProtocolErrorReason::VersionMismatch,
                        detail: format!("this core speaks protocol {PROTOCOL}"),
                    });
                }
                self.send(CoreMessage::Welcome {
                    protocol: PROTOCOL,
                    rev: self.store.rev(),
                });
            }
            ClientMessage::Subscribe { sub, query } => self.subscribe(sub, query),
            ClientMessage::Unsubscribe { sub } => {
                self.state.borrow_mut().subscriptions.shift_remove(&sub);
            }
            ClientMessage::Command { change, command } => self.on_command(change, command),
            ClientMessage::Request { id, request } => self.on_request(id, request),
        }
    }
}
