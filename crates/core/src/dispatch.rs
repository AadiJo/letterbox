//! Message dispatch. `receive` decodes each client message and hands it to the part
//! of the core that owns it: subscriptions, commands (`on_command`) or requests
//! (`on_request`). Everything the core sends goes out through `send`.

use std::rc::Rc;

use letterbox_protocol::{
    Answer, BlobError, ChangeId, ChangeResult, ClientMessage, Command, CoreMessage, PROTOCOL, ProtocolErrorReason,
    Refusal, Request, RequestId, Response, Rev,
};

use crate::changes::{Edit, resolve, targets};
use crate::world::{ChangeOutcome, ChangeRecord, ThreadRecord, put_change, put_thread};
use crate::{Inner, Subscription};

impl Inner {
    pub(crate) fn send(&self, message: CoreMessage) {
        (self.send)(message);
    }

    fn accepted(&self, change: &ChangeId, rev: Rev) {
        self.send(CoreMessage::Accepted {
            change: change.clone(),
            rev,
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
            // A turn correction never leaves the device, so it is done as soon as it is stored.
            let target = targets(&self.state.borrow().world, thread_ids);
            let target = match target {
                Ok(target) => target,
                Err(reason) => return self.send(CoreMessage::Rejected { change, reason }),
            };
            let turn_override = turn.fixed();
            let rev = self.commit_then(
                |world, tx, at| {
                    for id in &target.thread_ids {
                        if let Some(thread) = world.threads.get(id).cloned() {
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
                            account_id: target.account_id.clone(),
                            op: None,
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
            return self.send(CoreMessage::Settled {
                change,
                rev,
                result: ChangeResult::Done,
            });
        }

        let Some((thread_ids, edit)) = Edit::of(&command) else {
            // Set-turn was answered above. Send and undo are refused as not supported.
            let reason = Refusal::NotSupported;
            return self.send(CoreMessage::Rejected { change, reason });
        };
        let resolved = resolve(&self.state.borrow().world, thread_ids, edit);
        let (account_id, op) = match resolved {
            Ok(resolved) => resolved,
            Err(reason) => return self.send(CoreMessage::Rejected { change, reason }),
        };
        self.commit_then(
            |world, tx, at| {
                put_change(
                    world,
                    tx,
                    ChangeRecord {
                        id: change.clone(),
                        account_id: account_id.clone(),
                        op: Some(op),
                        accepted_rev: at,
                        outcome: None,
                    },
                );
            },
            |rev| self.accepted(&change, rev),
        );
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
            ClientMessage::Subscribe { sub, query } => {
                let subscription = Subscription {
                    query,
                    sent: String::new(),
                };
                self.state.borrow_mut().subscriptions.insert(sub, subscription);
                self.flush();
            }
            ClientMessage::Unsubscribe { sub } => {
                self.state.borrow_mut().subscriptions.shift_remove(&sub);
            }
            ClientMessage::Command { change, command } => self.on_command(change, command),
            ClientMessage::Request { id, request } => self.on_request(id, request),
        }
    }
}
