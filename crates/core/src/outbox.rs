//! The outbox: every message the user sends, from the moment the core accepts it until the
//! provider holds it. This module owns each step of a send, so its rules hold in one place:
//!
//!   - Accepting writes the message (see draft.rs) and stores it in the same commit as its
//!     change. The message shows in its conversation at once, in an outbox origin that
//!     names its change (`Origin::Outbox`). The turn rule leaves it out until the provider
//!     holds it (see rows.rs), so a send held, sending, unconfirmed or failed moves no turn.
//!   - It is `Held` for the core's undo window. `undo` removes it and settles it `undone`
//!     while the clock reads before the saved deadline, whether or not its timer has run
//!     (undo.rs passes every undo of a send here).
//!   - Then it is `Due`, and the account's next pass sends it in the order changes reach the
//!     provider. The core saves `Sending` before the call. An answer that it surely did not
//!     arrive puts it back to `Due`.
//!   - A provider offers no way to send a message only once. So a send that may have arrived
//!     without the core hearing so, because the answer was lost or the core stopped during
//!     the call, is `Unconfirmed` and is never sent again (adapter rule 10). Its checks
//!     (confirm.rs) look its Message-ID up until its window ends, then fail it `unconfirmed`,
//!     and sending again is the user's choice. A sync that brings its copy settles it too
//!     (see reconcile.rs).
//!   - Delivered, the same record takes the provider's ref in the commit that settles the
//!     change, so the conversation never shows it twice or drops it for a moment.
//!   - Refused, it stays in its conversation, marked failed with the reason.
//!   - A forward's attachments are fetched from the original's provider copy each time the
//!     send is about to go, before it is saved `Sending`, so a fetch that fails, or a core that
//!     stops during it, leaves it due. Only the text is saved: the files join it in memory
//!     (`attach` in mime.rs) under the same headers, so every try sends the same message. A file
//!     that is gone fails the send. A forward of a send of the user's that the provider does
//!     not hold yet waits, due, until that send settles: then a pass is queued, which carries
//!     it, or fails it with its original (`waiting_on`).

use std::rc::Rc;

use chrono::TimeDelta;
use letterbox_protocol::{
    AccountId, ChangeId, ChangeResult, CoreMessage, Delivery, Draft, MessageId, Refusal, Rev, Time,
};
use serde::{Deserialize, Serialize};
use tokio::task::spawn_local;

use crate::adapter::{AdapterFailure, AttachmentResult, BodyResult, MessageRef, Outgoing, SendResult};
use crate::body::Reading;
use crate::clock::{iso, parse};
use crate::draft::prepare;
use crate::effect::Effect;
use crate::forward::Forward;
use crate::mime::{File, attach};
use crate::reconcile::{remove_with_thread, thread_for};
use crate::sync::{PassResult, Pull};
use crate::world::{ChangeOutcome, ChangeRecord, MessageRecord, Origin, World, put_change, put_message};
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
    /// For a forward, what it carries of the original beyond its text.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub forward: Option<Forward>,
}

/// What a forward's files come to when it is about to go.
enum Contents {
    /// The content of the files it carries, in order. Empty for a send with no files.
    Ready(Vec<Vec<u8>>),
    /// The original is a send of the user's that the provider does not hold yet. The forward
    /// stays due until it does.
    Waiting,
    /// The original, or one of its files, is gone, or the original's own send failed.
    Gone,
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
    /// its checks look up its Message-ID until `until`, then it fails `unconfirmed` (confirm.rs).
    Unconfirmed { until: Time },
}

/// Sends whose provider copy a sync just found, already settled `done` in that sync's commit
/// (see `outbox_copy` in reconcile.rs). Their confirmation ends with them: a pass skips a
/// settled change. The caller announces them once the commit is in.
#[must_use = "each send settled here needs its `settled` message: pass it to `Inner::announce` after the commit"]
pub struct Arrived(pub(crate) Vec<ChangeId>);

/// What a send shows of itself on its message, or None once the provider holds it.
pub fn delivery(world: &World, record: &MessageRecord) -> Option<Delivery> {
    let Origin::Outbox { outbox } = &record.origin else {
        return None;
    };
    let change = world.changes.get(outbox)?;
    let Effect::Send(outbound) = &change.effect else {
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
            Err(reason) => return self.reject(change, reason),
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
                        reading: Reading::default(),
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
                    forward: prepared.forward,
                };
                put_change(
                    world,
                    tx,
                    ChangeRecord {
                        id: change.clone(),
                        account_id: prepared.account_id.clone(),
                        effect: Effect::Send(outbound),
                        accepted_rev: at,
                        outcome: None,
                    },
                );
            },
            |rev| self.accepted(&change, rev),
        );
        self.hold(change, &until);
    }

    /// Answers an undo of a send (see undo.rs). Only a send still in its undo window can be
    /// undone. Its message goes, in the commit that cancels it.
    pub(crate) fn undo_send(self: &Rc<Self>, change: ChangeId, record: ChangeRecord) {
        let Effect::Send(outbound) = &record.effect else {
            let reason = Refusal::NotSupported;
            return self.reject(change, reason);
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
            return self.reject(change, reason);
        }
        let message_id = outbound.message_id.clone();
        self.cancel(change, record, |world, tx| remove_with_thread(world, tx, &message_id));
    }

    /// Sends `settled` for each send a sync's commit at `rev` found the copy of, and queues a
    /// pass for any forward of one of them that waits.
    pub(crate) fn announce(self: &Rc<Self>, arrived: Arrived, rev: Rev) {
        for change in arrived.0 {
            self.waiting_on(&change);
            let result = ChangeResult::Done;
            self.send(CoreMessage::Settled { change, rev, result });
        }
    }

    /// Queues a pass for the account of `change` when it is a send that just settled, so the
    /// provider holds it or it failed, and a forward of its message waits for that (see
    /// `Contents::Waiting`). The pass sends the forward, or fails it with its original. Every
    /// way a send settles calls this: `delivered`, `announce` and `settle`. For a change that is
    /// not a send it does nothing.
    pub(crate) fn waiting_on(self: &Rc<Self>, change: &ChangeId) {
        let waiting = {
            let state = self.state.borrow();
            let changes = &state.world.changes;
            let delivered = changes.get(change).and_then(|record| match &record.effect {
                Effect::Send(outbound) => Some((record.account_id.clone(), outbound.message_id.clone())),
                _ => None,
            });
            delivered.filter(|(_, message_id)| {
                changes.values().filter(|later| later.outcome.is_none()).any(|later| {
                    matches!(&later.effect, Effect::Send(Outbound { stage: Stage::Due, forward: Some(forward), .. }) if forward.of == *message_id)
                })
            })
        };
        if let Some((account_id, _)) = waiting {
            self.background(&account_id, Rc::clone(self).pass(account_id.clone(), Pull::No));
        }
    }

    /// Picks up every send a restart found on its way. A held one restarts its undo window,
    /// and one whose window ended while the core was stopped becomes due at once. Each account
    /// with a due send gets one pass, which carries it: a start runs no pass of its own, and a
    /// forward stopped while its files were fetched is due. One that may have reached the
    /// provider (sending or unconfirmed) gets one check, at once (see confirm.rs).
    pub(crate) fn resume_outbox(self: &Rc<Self>) {
        let waiting: Vec<(ChangeRecord, Stage)> = self
            .state
            .borrow()
            .world
            .changes
            .values()
            .filter(|change| change.outcome.is_none())
            .filter_map(|change| match &change.effect {
                Effect::Send(outbound) => Some((change.clone(), outbound.stage.clone())),
                _ => None,
            })
            .collect();
        let mut due: Vec<AccountId> = Vec::new();
        for (change, stage) in waiting {
            match stage {
                Stage::Held { until } => self.hold(change.id, &until),
                Stage::Sending | Stage::Unconfirmed { .. } => self.book_check(&change.account_id, change.id, None),
                Stage::Due if !due.contains(&change.account_id) => due.push(change.account_id),
                Stage::Due => {}
            }
        }
        for account_id in due {
            self.background(&account_id, Rc::clone(self).pass(account_id.clone(), Pull::No));
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
        let Effect::Send(outbound) = record.effect.clone() else {
            return;
        };
        let account_id = record.account_id.clone();
        self.restage(record, &outbound, Stage::Due);
        self.background(&account_id, Rc::clone(self).pass(account_id.clone(), Pull::No));
    }

    /// Moves a send to `stage` in one commit, and returns its record as stored.
    pub(crate) fn restage(self: &Rc<Self>, record: ChangeRecord, outbound: &Outbound, stage: Stage) -> ChangeRecord {
        let effect = Effect::Send(Outbound {
            stage,
            ..outbound.clone()
        });
        let staged = ChangeRecord { effect, ..record };
        self.commit(|world, tx, _| put_change(world, tx, staged.clone()));
        staged
    }

    /// Saves that a call to send has started, and the size of the message as it goes, files
    /// and all, in one commit. The provider's copy reports that size, and a provider that gives
    /// a moved message a new ref is matched to its copy by it (see `fingerprint` in reconcile.rs).
    fn start_sending(self: &Rc<Self>, record: ChangeRecord, outbound: &Outbound, size: u64) -> ChangeRecord {
        let effect = Effect::Send(Outbound {
            stage: Stage::Sending,
            ..outbound.clone()
        });
        let staged = ChangeRecord { effect, ..record };
        self.commit(|world, tx, _| {
            put_change(world, tx, staged.clone());
            let message = world.messages.get(&outbound.message_id).cloned();
            if let Some(mut message) = message.filter(|message| message.facts.size != size) {
                message.facts.size = size;
                put_message(world, tx, message);
            }
        });
        staged
    }

    /// Carries one send as far as its stage allows. Returns why the provider was not
    /// reached, if it was not. The send then stays where it was. A send that may have reached
    /// the provider is its checks' to settle (see confirm.rs): a pass only makes sure one is booked.
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
            Stage::Sending | Stage::Unconfirmed { .. } => {
                self.book_check(account_id, record.id, None);
                Ok(())
            }
        }
    }

    /// The content of a forward's files, fetched from the provider's copy of the original.
    /// Empty for any other send. A failure here means nothing was sent.
    async fn contents(&self, linked: &Linked, outbound: &Outbound) -> Result<Contents, AdapterFailure> {
        let Some(forward) = outbound
            .forward
            .as_ref()
            .filter(|forward| forward.carried().next().is_some())
        else {
            return Ok(Contents::Ready(Vec::new()));
        };
        let r#ref = {
            let state = self.state.borrow();
            let world = &state.world;
            let original = world.messages.get(&forward.of);
            match original.map(|record| (&record.origin, &record.body)) {
                None | Some((_, Some(BodyResult::Gone))) => return Ok(Contents::Gone),
                Some((Origin::Provider { r#ref }, _)) => r#ref.clone(),
                // Its send is on its way, so it gets a ref once the provider holds it (`waiting_on`).
                Some((Origin::Outbox { outbox }, _)) => {
                    let pending = world.changes.get(outbox).is_some_and(|send| send.outcome.is_none());
                    return Ok(if pending { Contents::Waiting } else { Contents::Gone });
                }
            }
        };
        let mut contents = Vec::with_capacity(forward.files.len());
        for (index, _) in forward.carried() {
            match linked.adapter.attachment(r#ref.clone(), index).await? {
                AttachmentResult::Bytes(bytes) => contents.push(bytes),
                AttachmentResult::Gone => return Ok(Contents::Gone),
            }
        }
        Ok(Contents::Ready(contents))
    }

    /// Sends a due message, the one call to `send` it ever gets unless the provider surely did not get it.
    async fn post(
        self: &Rc<Self>,
        account_id: &AccountId,
        linked: &Linked,
        record: ChangeRecord,
        outbound: Outbound,
    ) -> PassResult {
        let contents = self.contents(linked, &outbound).await;
        if !self.still_current(account_id, linked) {
            return Ok(());
        }
        let contents = match contents? {
            Contents::Ready(contents) => contents,
            Contents::Waiting => return Ok(()),
            Contents::Gone => {
                self.settle(record, ChangeResult::Failed(Refusal::UnknownTarget));
                return Ok(());
            }
        };
        let files = outbound.forward.iter().flat_map(Forward::carried);
        let files: Vec<File<'_>> = files
            .zip(&contents)
            .map(|((_, file), bytes)| File {
                name: &file.name,
                mime: &file.mime,
                inline: file.inline,
                bytes,
            })
            .collect();
        let raw = attach(&outbound.raw, &files);
        let record = self.start_sending(record, &outbound, raw.len() as u64);
        let reply_to = {
            let state = self.state.borrow();
            let parent = outbound.reply_to.as_ref().and_then(|id| state.world.messages.get(id));
            parent.and_then(|parent| parent.provider_ref().cloned())
        };
        let outgoing = Outgoing {
            raw,
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
            Ok(SendResult::Unconfirmed) => {
                self.unconfirm(record, &outbound);
                Ok(())
            }
        }
    }

    /// Settles a send the provider holds under `ref`. Its outbox message becomes that copy in
    /// the same commit, so it keeps its id.
    pub(crate) fn delivered(
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
        self.waiting_on(&id);
        let result = ChangeResult::Done;
        self.send(CoreMessage::Settled {
            change: id,
            rev,
            result,
        });
    }
}
