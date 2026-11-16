//! The outbox: every message the user sends, from the moment the core accepts it until the
//! provider holds it. This module owns each step of a send, so its rules hold in one place:
//!
//!   - Accepting writes the message (see mime.rs) and stores it in the same commit as its
//!     change. The message shows in its conversation at once, in an outbox origin that
//!     names its change (`Origin::Outbox`), and the turn rule reads it like any other.
//!   - It is held for the core's undo window. `undo` inside the window removes it and
//!     settles it `undone`. The end of the window is saved, so a restart keeps it.
//!   - Once the window ends the send is due, and the account's next pass delivers it in
//!     the order changes reach the provider. Before each delivery the core saves that it
//!     tried, so a later try after a crash or a lost answer asks the provider first
//!     (adapter rule 10). That is how a send reaches the provider exactly once.
//!   - Delivered, the same record takes the provider's ref in the commit that settles the
//!     change, so the conversation never shows it twice or drops it for a moment.
//!   - Refused, it stays in its conversation, marked failed with the provider's reason.

use std::rc::Rc;

use chrono::{SubsecRound, TimeDelta};
use letterbox_protocol::{
    AccountId, ChangeId, ChangeResult, CoreMessage, Delivery, Draft, MessageId, Refusal, Role, Time,
};
use serde::{Deserialize, Serialize};
use tokio::task::spawn_local;

use crate::adapter::{BodyResult, Outgoing, RemoteAddress, RemoteBody, RemoteFacts, RemoteHeaders, SendResult};
use crate::clock::{iso, parse};
use crate::mime::{Letter, is_plain_address, write};
use crate::reconcile::{remove_with_thread, thread_for};
use crate::sync::PassResult;
use crate::world::{
    ChangeOutcome, ChangeRecord, MessageRecord, MessageState, Op, Origin, World, put_change, put_message,
};
use crate::{Inner, Linked};

/// A send on its way out, as its change carries it. Its message is `message_id`, an outbox
/// message until the provider holds it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Outbound {
    pub message_id: MessageId,
    pub stage: Stage,
    /// The message as written, without a Bcc header.
    pub raw: String,
    pub bcc: Vec<String>,
    /// Its Message-ID header, without angle brackets.
    pub header_id: String,
    /// The message it answers.
    pub reply_to: Option<MessageId>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "stage", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum Stage {
    /// In its undo window until `until`. A pass leaves it alone. `undo` cancels it.
    Held { until: Time },
    /// Out of its window. `tried` turns true, in the store, before the first call to send it.
    Due { tried: bool },
}

/// What a send shows of itself on its message, or None once the provider holds it.
pub fn delivery(world: &World, record: &MessageRecord) -> Option<Delivery> {
    let Origin::Outbox { outbox } = &record.origin else {
        return None;
    };
    let change = world.changes.get(outbox)?;
    let Some(Op::Send(outbound)) = &change.op else {
        return None;
    };
    let id = change.id.clone();
    match (change.outcome.map(|outcome| outcome.result), &outbound.stage) {
        (Some(ChangeResult::Failed(reason)), _) => Some(Delivery::Failed { change: id, reason }),
        (Some(_), _) => None,
        (None, Stage::Held { until }) => Some(Delivery::Held {
            change: id,
            until: until.clone(),
        }),
        (None, Stage::Due { .. }) => Some(Delivery::Sending { change: id }),
    }
}

/// A send that passed every check, ready to store.
struct Prepared {
    account_id: AccountId,
    facts: RemoteFacts,
    body: RemoteBody,
    server: MessageState,
    raw: String,
    bcc: Vec<String>,
    header_id: String,
}

/// The start of the text as a list row shows it: no quoted lines, single spaces, at most
/// 200 characters. The sim provider's `previewOf` gives the same for the copy it keeps.
fn preview_of(text: &str) -> String {
    let kept: Vec<&str> = text.lines().filter(|line| !line.starts_with('>')).collect();
    kept.join(" ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(200)
        .collect()
}

/// Checks a draft and writes its message, or says why it cannot be sent.
fn prepare(world: &World, draft: &Draft, now: &Time, random: u64) -> Result<Prepared, Refusal> {
    let account = world.accounts.get(&draft.account_id).ok_or(Refusal::UnknownTarget)?;
    if !account.capabilities.modify {
        return Err(Refusal::NotPermitted);
    }
    if !account.capabilities.send {
        return Err(Refusal::NotSupported);
    }
    let everyone = draft.to.iter().chain(&draft.cc).chain(&draft.bcc);
    if draft.to.is_empty() && draft.cc.is_empty() && draft.bcc.is_empty() {
        return Err(Refusal::Invalid);
    }
    if !everyone.clone().all(|address| is_plain_address(address)) || draft.subject.contains(['\r', '\n']) {
        return Err(Refusal::Invalid);
    }
    let parent = match &draft.in_reply_to {
        None => None,
        Some(id) => {
            let parent = world.messages.get(id).filter(|parent| parent.account_id == account.id);
            Some(parent.ok_or(Refusal::UnknownTarget)?)
        }
    };
    let references: Vec<String> = parent
        .map(|parent| {
            parent
                .facts
                .references
                .iter()
                .chain(&parent.facts.message_id)
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    // A Date header holds whole seconds, so the facts keep the same time the header says.
    let date = parse(now).trunc_subsecs(0);
    let domain = account
        .address
        .rsplit_once('@')
        .map_or("letterbox.invalid", |(_, domain)| domain);
    let header_id = format!("{}.{random:016x}@{domain}", date.timestamp_millis());
    let text = draft.text.replace("\r\n", "\n");
    let raw = write(&Letter {
        from: &account.address,
        to: &draft.to,
        cc: &draft.cc,
        subject: &draft.subject,
        date,
        message_id: &header_id,
        references: &references,
        text: &text,
        html: draft.html.as_deref(),
    });
    let addresses = |list: &[String]| -> Vec<RemoteAddress> {
        let bare = |address: &String| RemoteAddress {
            name: None,
            address: address.clone(),
        };
        list.iter().map(bare).collect()
    };
    let sent = world
        .mailboxes
        .values()
        .find(|mailbox| mailbox.account_id == account.id && mailbox.role == Some(Role::Sent));
    Ok(Prepared {
        account_id: account.id.clone(),
        facts: RemoteFacts {
            message_id: Some(header_id.clone()),
            references,
            subject: draft.subject.clone(),
            from: RemoteAddress {
                name: None,
                address: account.address.clone(),
            },
            to: addresses(&draft.to),
            cc: addresses(&draft.cc),
            sent_at: iso(date),
            preview: preview_of(&text),
            size: raw.len() as u64,
            has_attachments: false,
            headers: RemoteHeaders {
                list_unsubscribe: false,
                list_id: false,
                precedence: String::new(),
                auto_submitted: String::new(),
            },
            bulk: None,
        },
        body: RemoteBody {
            text,
            html: draft.html.clone(),
            attachments: Vec::new(),
        },
        server: MessageState {
            mailboxes: sent.map(|mailbox| mailbox.id.clone()).into_iter().collect(),
            unread: false,
            flagged: false,
        },
        raw,
        bcc: draft.bcc.clone(),
        header_id,
    })
}

impl Inner {
    /// Accepts a send: stores its message and its change in one commit, then starts its undo window.
    pub(crate) fn send_draft(self: &Rc<Self>, change: ChangeId, draft: &Draft) {
        let now = self.env.now();
        let prepared = prepare(&self.state.borrow().world, draft, &now, self.env.random());
        let prepared = match prepared {
            Ok(prepared) => prepared,
            Err(reason) => return self.send(CoreMessage::Rejected { change, reason }),
        };
        let window = TimeDelta::from_std(self.undo_window).unwrap_or(TimeDelta::MAX);
        let until = iso(parse(&now).checked_add_signed(window).unwrap_or(parse(&now)));
        self.commit_then(
            |world, tx, at| {
                // The message id is minted before the thread id, as reconcile does.
                let message_id: MessageId = tx.next_id();
                let thread_id = thread_for(world, tx, &prepared.account_id, &prepared.facts);
                put_message(
                    world,
                    tx,
                    MessageRecord {
                        id: message_id.clone(),
                        account_id: prepared.account_id.clone(),
                        origin: Origin::Outbox { outbox: change.clone() },
                        thread_id,
                        facts: prepared.facts,
                        server: prepared.server,
                        body: Some(BodyResult::Body { body: prepared.body }),
                        round: 0,
                    },
                );
                let outbound = Outbound {
                    message_id,
                    stage: Stage::Held { until: until.clone() },
                    raw: prepared.raw,
                    bcc: prepared.bcc,
                    header_id: prepared.header_id,
                    reply_to: draft.in_reply_to.clone(),
                };
                put_change(
                    world,
                    tx,
                    ChangeRecord {
                        id: change.clone(),
                        account_id: prepared.account_id.clone(),
                        op: Some(Op::Send(outbound)),
                        accepted_rev: at,
                        outcome: None,
                    },
                );
            },
            |rev| self.accepted(&change, rev),
        );
        self.hold(change, &until);
    }

    /// Answers an undo. Only a send still in its undo window can be undone. Its message goes
    /// and it settles `undone`, in the commit that stores the undo, which settles `done`.
    pub(crate) fn undo_send(self: &Rc<Self>, change: ChangeId, target: &ChangeId) {
        let found = self.state.borrow().world.changes.get(target).cloned();
        let Some(record) = found else {
            let reason = Refusal::UnknownTarget;
            return self.send(CoreMessage::Rejected { change, reason });
        };
        let message_id = match &record.op {
            Some(Op::Send(outbound)) if matches!(outbound.stage, Stage::Held { .. }) && record.outcome.is_none() => {
                outbound.message_id.clone()
            }
            // Mail cannot be unsent once its window ends, and it can be undone only once.
            Some(Op::Send(_)) => {
                return self.send(CoreMessage::Rejected {
                    change,
                    reason: Refusal::Conflict,
                });
            }
            _ => {
                return self.send(CoreMessage::Rejected {
                    change,
                    reason: Refusal::NotSupported,
                });
            }
        };
        let done = |at| {
            Some(ChangeOutcome {
                rev: at,
                result: ChangeResult::Done,
            })
        };
        let rev = self.commit_then(
            |world, tx, at| {
                remove_with_thread(world, tx, &message_id);
                let undone = Some(ChangeOutcome {
                    rev: at,
                    result: ChangeResult::Undone,
                });
                let account_id = record.account_id.clone();
                put_change(
                    world,
                    tx,
                    ChangeRecord {
                        outcome: undone,
                        ..record
                    },
                );
                let undo = ChangeRecord {
                    id: change.clone(),
                    account_id,
                    op: None,
                    accepted_rev: at,
                    outcome: done(at),
                };
                put_change(world, tx, undo);
            },
            |rev| self.accepted(&change, rev),
        );
        let undone = ChangeResult::Undone;
        self.send(CoreMessage::Settled {
            change: target.clone(),
            rev,
            result: undone,
        });
        self.send(CoreMessage::Settled {
            change,
            rev,
            result: ChangeResult::Done,
        });
    }

    /// Restarts the undo window of every send a restart found held. One whose window ended
    /// while the core was stopped becomes due at once.
    pub(crate) fn resume_outbox(self: &Rc<Self>) {
        let held: Vec<(ChangeId, Time)> = self
            .state
            .borrow()
            .world
            .changes
            .values()
            .filter(|change| change.outcome.is_none())
            .filter_map(|change| match &change.op {
                Some(Op::Send(Outbound {
                    stage: Stage::Held { until },
                    ..
                })) => Some((change.id.clone(), until.clone())),
                _ => None,
            })
            .collect();
        for (change, until) in held {
            self.hold(change, &until);
        }
    }

    /// Waits out one send's undo window, then makes it due. The wait is not work the core
    /// finishes before it closes: a closing core leaves the send held, and the next start resumes it.
    fn hold(self: &Rc<Self>, change: ChangeId, until: &Time) {
        let window = self.env.until(until);
        let core = Rc::clone(self);
        spawn_local(async move {
            window.await;
            if !core.work.is_closed() {
                core.release(&change);
            }
        });
    }

    /// Ends a send's undo window, unless it was undone, and queues a pass to deliver it.
    fn release(self: &Rc<Self>, change: &ChangeId) {
        let found = self.state.borrow().world.changes.get(change).cloned();
        let Some(record) = found.filter(|record| record.outcome.is_none()) else {
            return;
        };
        let Some(Op::Send(outbound)) = record.op.clone() else {
            return;
        };
        let account_id = record.account_id.clone();
        self.commit(|world, tx, _| {
            let stage = Stage::Due { tried: false };
            let op = Some(Op::Send(Outbound { stage, ..outbound }));
            put_change(world, tx, ChangeRecord { op, ..record });
        });
        self.background(&account_id, Rc::clone(self).pass(account_id.clone(), false));
    }

    /// Carries one send to the provider if its window has ended. Returns how the provider
    /// answered, or why it was not reached, in which case the send stays due.
    pub(crate) async fn deliver(
        self: &Rc<Self>,
        account_id: &AccountId,
        linked: &Linked,
        record: ChangeRecord,
        outbound: Outbound,
    ) -> PassResult {
        let Stage::Due { tried } = outbound.stage else {
            return Ok(());
        };
        let record = if tried {
            record
        } else {
            let stage = Stage::Due { tried: true };
            let op = Some(Op::Send(Outbound {
                stage,
                ..outbound.clone()
            }));
            let marked = ChangeRecord { op, ..record };
            self.commit(|world, tx, _| put_change(world, tx, marked.clone()));
            marked
        };
        let reply_to = {
            let state = self.state.borrow();
            let parent = outbound.reply_to.as_ref().and_then(|id| state.world.messages.get(id));
            parent.and_then(|parent| parent.provider_ref().cloned())
        };
        let outgoing = Outgoing {
            raw: outbound.raw,
            bcc: outbound.bcc,
            message_id: outbound.header_id,
            reply_to,
            maybe_sent: tried,
        };
        let answer = linked.adapter.send(outgoing).await?;
        if !self.still_current(account_id, linked) {
            return Ok(());
        }
        let r#ref = match answer {
            SendResult::Refused { reason } => {
                // The message stays, so the user sees the send failed (see `delivery`).
                self.settle(record, ChangeResult::Failed(reason.into()));
                return Ok(());
            }
            SendResult::Sent { r#ref } => r#ref,
        };
        let id = record.id.clone();
        let rev = self.commit(|world, tx, at| {
            let message = world.messages.get(&outbound.message_id).cloned();
            let round = world.accounts.get(account_id).map_or(0, |account| account.round);
            if let Some(message) = message {
                let origin = Origin::Provider { r#ref };
                put_message(
                    world,
                    tx,
                    MessageRecord {
                        origin,
                        round,
                        ..message
                    },
                );
            }
            let outcome = Some(ChangeOutcome {
                rev: at,
                result: ChangeResult::Done,
            });
            put_change(world, tx, ChangeRecord { outcome, ..record });
        });
        let result = ChangeResult::Done;
        self.send(CoreMessage::Settled {
            change: id,
            rev,
            result,
        });
        Ok(())
    }
}
