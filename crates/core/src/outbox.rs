//! The outbox: every message the user sends, from the moment the core accepts it until the
//! provider holds it. This module owns each step of a send, so its rules hold in one place:
//!
//!   - Accepting writes the message (see draft.rs) and stores it in the same commit as its
//!     change. The message shows in its conversation at once, in an outbox origin that
//!     names its change (`Origin::Outbox`), and the turn rule reads it like any other.
//!   - It is `Held` for the core's undo window. `undo` removes it and settles it `undone`
//!     while the clock reads before the saved deadline, whether or not its timer has run.
//!   - Then it is `Due`, and the account's next pass sends it in the order changes reach the
//!     provider. The core saves `Sending` before the call. An answer that it surely did not
//!     arrive puts it back to `Due`.
//!   - A provider offers no way to send a message only once. So a send that may have arrived
//!     without the core hearing so, because the answer was lost or the core stopped during
//!     the call, is `Unconfirmed` and is never sent again (adapter rule 10). The core looks
//!     its Message-ID up at once and a few times more across the confirm window. Found, it is
//!     delivered. Not found by the end, it fails `unconfirmed`, and sending again is the
//!     user's choice. A copy that turns up later still takes its place (see reconcile.rs).
//!   - Delivered, the same record takes the provider's ref in the commit that settles the
//!     change, so the conversation never shows it twice or drops it for a moment.
//!   - Refused, it stays in its conversation, marked failed with the reason.

use std::rc::Rc;

use chrono::TimeDelta;
use letterbox_protocol::{AccountId, ChangeId, ChangeResult, CoreMessage, Delivery, Draft, MessageId, Refusal, Time};
use serde::{Deserialize, Serialize};
use tokio::task::spawn_local;

use crate::adapter::{BodyResult, MessageRef, Outgoing, SendResult};
use crate::clock::{iso, parse};
use crate::draft::prepare;
use crate::reconcile::{remove_with_thread, thread_for};
use crate::sync::PassResult;
use crate::world::{ChangeOutcome, ChangeRecord, MessageRecord, Op, Origin, World, put_change, put_message};
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
    /// Out of its window, and no call to send it has started. A pass sends it.
    Due,
    /// A call to send it has started. Saved before the call, so a core that stops during it
    /// finds it here, and treats it as `Unconfirmed`.
    Sending,
    /// It may have reached the provider without the core hearing so. It is never sent again:
    /// passes look up its Message-ID until `until`, then it fails `unconfirmed`.
    Unconfirmed { until: Time },
}

/// How many more times an unconfirmed send is looked up after the first, spread across the window.
const MORE_LOOKUPS: u32 = 4;

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
        (None, Stage::Due | Stage::Sending | Stage::Unconfirmed { .. }) => Some(Delivery::Sending { change: id }),
    }
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
        let Some(Op::Send(outbound)) = &record.op else {
            let reason = Refusal::NotSupported;
            return self.send(CoreMessage::Rejected { change, reason });
        };
        // The saved deadline decides, not whether its timer has run yet: the clock can pass
        // it first, and a restart starts the timers again only after it opens the store.
        let open = match (&outbound.stage, record.outcome) {
            (Stage::Held { until }, None) => parse(&self.env.now()) < parse(until),
            _ => false,
        };
        // Mail cannot be unsent once its window ends, and it can be undone only once.
        if !open {
            let reason = Refusal::Conflict;
            return self.send(CoreMessage::Rejected { change, reason });
        }
        let message_id = outbound.message_id.clone();
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
        self.restage(record, &outbound, Stage::Due);
        self.background(&account_id, Rc::clone(self).pass(account_id.clone(), false));
    }

    /// Moves a send to `stage` in one commit, and returns its record as stored.
    fn restage(self: &Rc<Self>, record: ChangeRecord, outbound: &Outbound, stage: Stage) -> ChangeRecord {
        let op = Some(Op::Send(Outbound {
            stage,
            ..outbound.clone()
        }));
        let staged = ChangeRecord { op, ..record };
        self.commit(|world, tx, _| put_change(world, tx, staged.clone()));
        staged
    }

    /// Carries one send as far as its stage allows. Returns why the provider was not
    /// reached, if it was not. The send then stays where it was.
    pub(crate) async fn deliver(
        self: &Rc<Self>,
        account_id: &AccountId,
        linked: &Linked,
        record: ChangeRecord,
        outbound: Outbound,
    ) -> PassResult {
        match outbound.stage.clone() {
            Stage::Held { .. } => Ok(()),
            Stage::Due => self.post(account_id, linked, record, outbound).await,
            // A call started and the core stopped before its answer, so the provider may hold it.
            Stage::Sending => self.unconfirmed(account_id, linked, record, outbound).await,
            Stage::Unconfirmed { until } => self.confirm(account_id, linked, record, outbound, &until).await,
        }
    }

    /// Sends a due message, the one call to `send` it ever gets unless the provider surely did not get it.
    async fn post(
        self: &Rc<Self>,
        account_id: &AccountId,
        linked: &Linked,
        record: ChangeRecord,
        outbound: Outbound,
    ) -> PassResult {
        let record = self.restage(record, &outbound, Stage::Sending);
        let reply_to = {
            let state = self.state.borrow();
            let parent = outbound.reply_to.as_ref().and_then(|id| state.world.messages.get(id));
            parent.and_then(|parent| parent.provider_ref().cloned())
        };
        let outgoing = Outgoing {
            raw: outbound.raw.clone(),
            bcc: outbound.bcc.clone(),
            message_id: outbound.header_id.clone(),
            reply_to,
        };
        let answer = linked.adapter.send(outgoing).await;
        if !self.still_current(account_id, linked) {
            return Ok(());
        }
        match answer {
            // It surely did not reach the provider (rule 10), so a later pass sends it again.
            Err(failure) => {
                self.restage(record, &outbound, Stage::Due);
                Err(failure)
            }
            Ok(SendResult::Sent { r#ref }) => {
                self.delivered(account_id, record, &outbound, r#ref);
                Ok(())
            }
            Ok(SendResult::Refused { reason }) => {
                // The message stays, so the user sees the send failed (see `delivery`).
                self.settle(record, ChangeResult::Failed(reason.into()));
                Ok(())
            }
            Ok(SendResult::Unconfirmed) => self.unconfirmed(account_id, linked, record, outbound).await,
        }
    }

    /// Marks a send that may have reached the provider, with the end of its confirm window, and looks it up.
    async fn unconfirmed(
        self: &Rc<Self>,
        account_id: &AccountId,
        linked: &Linked,
        record: ChangeRecord,
        outbound: Outbound,
    ) -> PassResult {
        let window = TimeDelta::from_std(self.confirm_window).unwrap_or(TimeDelta::MAX);
        let now = parse(&self.env.now());
        let until = iso(now.checked_add_signed(window).unwrap_or(now));
        let stage = Stage::Unconfirmed { until: until.clone() };
        let record = self.restage(record, &outbound, stage);
        self.confirm(account_id, linked, record, outbound, &until).await
    }

    /// Looks for an unconfirmed send at the provider. Found, it is delivered. Not found, it is
    /// looked for again later, and once the window has ended it fails. It is never sent again.
    async fn confirm(
        self: &Rc<Self>,
        account_id: &AccountId,
        linked: &Linked,
        record: ChangeRecord,
        outbound: Outbound,
        until: &Time,
    ) -> PassResult {
        let found = linked.adapter.find(outbound.header_id.clone()).await?;
        if !self.still_current(account_id, linked) {
            return Ok(());
        }
        match found.r#ref {
            Some(r#ref) => self.delivered(account_id, record, &outbound, r#ref),
            None if parse(&self.env.now()) >= parse(until) => {
                self.settle(record, ChangeResult::Failed(Refusal::Unconfirmed));
            }
            None => self.look_again(account_id, until),
        }
        Ok(())
    }

    /// Queues the next lookup of an unconfirmed send, a step into its window or at its end.
    /// Like the undo window, the wait is not work a closing core finishes.
    fn look_again(self: &Rc<Self>, account_id: &AccountId, until: &Time) {
        let step = TimeDelta::from_std(self.confirm_window / MORE_LOOKUPS).unwrap_or(TimeDelta::MAX);
        let now = parse(&self.env.now());
        let next = now.checked_add_signed(step).unwrap_or(now).min(parse(until));
        let wait = self.env.until(&iso(next));
        let core = Rc::clone(self);
        let account_id = account_id.clone();
        spawn_local(async move {
            wait.await;
            if !core.work.is_closed() {
                core.background(&account_id, Rc::clone(&core).pass(account_id.clone(), false));
            }
        });
    }

    /// Settles a send the provider holds under `ref`. Its outbox message becomes that copy in
    /// the same commit, so it keeps its id.
    fn delivered(
        self: &Rc<Self>,
        account_id: &AccountId,
        record: ChangeRecord,
        outbound: &Outbound,
        r#ref: MessageRef,
    ) {
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
    }
}
