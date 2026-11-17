//! What each change does, and what it altered, so an undo takes back exactly that (undo.rs).
//!
//! Every change record carries one `Effect`. A change that alters messages or turns records,
//! when it is accepted, each field it changed with both ends. For a message: the mailboxes it
//! put it in (it was out of them before) and took it out of (it was in them), and the read and
//! flag state it had before, for each of the two it changed (it set the other value). For a
//! conversation: the turn the user had set before, and the one set now, as they held then (see
//! `held_override` in turns.rs), and when its newest message was sent. The records are built
//! only by `MessageEffect::new` and `TurnEffect::new`, which read the world as the user sees it
//! then. A message the change named but did not alter is left out, so its undo never touches it.
//!
//! What a change carries to the provider is built from that record too, so a change does only
//! what it recorded. One that altered nothing does nothing, even if the change before it, which
//! it took as done, is refused later. An undo is accepted only while every field the change set
//! still holds what it set (`Effect::conflict`), so it never overwrites a later change, made
//! here or at the provider. What a change did at the provider counts only once the provider
//! confirmed it: by its answers, or by a sync after them (`MessageEffect::landed`).

use letterbox_protocol::{ChangeId, MailboxId, MessageId, ThreadId, Time, Turn, UndoConflict, UndoField};
use serde::{Deserialize, Deserializer, Serialize};

use crate::changes::{Pending, overlay};
use crate::clock::parse;
use crate::maps::IndexSet;
use crate::outbox::Outbound;
use crate::turns::{held_override, newest_held};
use crate::world::{MailboxMode, MessageState, Op, World};

/// What one change does. Its kind decides how an undo answers (see undo.rs).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum Effect {
    /// Flags or mailboxes, which the account's passes carry to the provider.
    Messages(MessageEffect),
    /// Turn corrections, which never leave the device.
    Turns(TurnEffect),
    /// A message the user sent, on its way out (see outbox.rs).
    Send(Outbound),
    /// An undo that cancelled `of` before the provider had any of it. It alters nothing itself.
    Cancel { of: ChangeId },
    /// Accepted by a core from before changes recorded what they altered. It still reaches
    /// the provider, but cannot be undone. Only stores written back then hold one.
    Unrecorded { op: Option<Op> },
}

impl Effect {
    /// The Ops a pass carries to the provider, oldest first. Empty for a change that has none.
    pub fn ops(&self) -> &[Op] {
        match self {
            Effect::Messages(effect) => &effect.ops,
            Effect::Unrecorded { op } => op.as_slice(),
            Effect::Turns(_) | Effect::Send(_) | Effect::Cancel { .. } => &[],
        }
    }

    /// Every message the change names, so the views can mark it pending and redraw it.
    pub fn named(&self) -> impl Iterator<Item = &MessageId> {
        let sent = match self {
            Effect::Send(outbound) => Some(&outbound.message_id),
            _ => None,
        };
        self.ops().iter().flat_map(Op::message_ids).chain(sent)
    }

    /// The change an undo takes back, for a change that is an undo.
    pub fn undoes(&self) -> Option<&ChangeId> {
        match self {
            Effect::Messages(effect) => effect.undoes.as_ref(),
            Effect::Turns(effect) => effect.undoes.as_ref(),
            Effect::Cancel { of } => Some(of),
            Effect::Send(_) | Effect::Unrecorded { .. } => None,
        }
    }

    /// The first field this change set that no longer holds what it set, as the user sees it
    /// now: changed since, by a change here or at the provider, or gone with its message or
    /// conversation. None when every field holds, and for a change that sets none.
    pub fn conflict(&self, world: &World) -> Option<UndoField> {
        match self {
            Effect::Messages(effect) => {
                let pending = Pending::of(world);
                effect.altered.iter().find_map(|altered| {
                    let now = world.messages.get(&altered.message_id);
                    altered.unheld(now.map(|record| pending.view_state(record)).as_deref())
                })
            }
            // A turn no longer holds what was set once the conversation moved: a message sent
            // after the change's newest. Its undo would put back a turn over that message.
            Effect::Turns(effect) => effect
                .altered
                .iter()
                .find(|altered| {
                    let Some(thread) = world.threads.get(&altered.thread_id) else {
                        return true;
                    };
                    let newest = newest_held(world, &altered.thread_id);
                    let moved = newest
                        .as_ref()
                        .zip(altered.newest.as_ref())
                        .is_some_and(|(newest, then)| parse(newest) > parse(then));
                    moved || held_override(thread, newest.as_ref()) != altered.now
                })
                .map(|altered| UndoField::Turn {
                    thread_id: altered.thread_id.clone(),
                }),
            Effect::Send(_) | Effect::Cancel { .. } | Effect::Unrecorded { .. } => None,
        }
    }
}

/// A change to flags or mailboxes. Build one with `MessageEffect::new`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageEffect {
    /// What a pass carries to the provider while the change is pending, built from `altered` alone.
    ops: Vec<Op>,
    altered: Vec<Altered>,
    /// True once the provider may hold part of it: an undo then cannot cancel it. A pass saves
    /// it before each call, and clears it when no call for it went through (see push.rs).
    reached: bool,
    /// True while a call for it went out and no answer said what became of it: from before the
    /// call until the answer, so through a lost answer or a restart too. A sync then settles it
    /// from what the provider holds (`landed`).
    #[serde(default)]
    unconfirmed: bool,
    /// For a change that failed after part of it went through: a sync has run since, so what
    /// the user sees of its fields is what the provider holds (undo.rs).
    #[serde(default)]
    refreshed: bool,
    undoes: Option<ChangeId>,
}

/// How much of a change the provider holds, as it last reported: of the fields the change
/// set on messages still there, all, some or none hold the change's value.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Landed {
    All,
    Some,
    None,
    /// None of the messages it altered are left.
    Gone,
}

/// What one change altered on one message. It put the message in `added`, which it was not in,
/// and took it out of `removed`, which it was in. `was_unread` and `was_flagged` hold the value
/// each had, for the ones the change set to the other value.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Altered {
    message_id: MessageId,
    added: Vec<MailboxId>,
    removed: Vec<MailboxId>,
    was_unread: Option<bool>,
    was_flagged: Option<bool>,
}

impl Altered {
    /// The Ops that set each field as the change left it, or as it was if `back`.
    fn ops(&self, mode: MailboxMode, back: bool) -> [Option<Op>; 2] {
        let (into, out_of) = if back {
            (&self.removed, &self.added)
        } else {
            (&self.added, &self.removed)
        };
        let boxes = match mode {
            MailboxMode::Sets => (!into.is_empty() || !out_of.is_empty()).then(|| (into.clone(), out_of.clone())),
            // A move took the message out of one folder and into another.
            MailboxMode::Move => into
                .first()
                .zip(out_of.first())
                .map(|(to, from)| (vec![to.clone()], vec![from.clone()])),
        };
        let mailboxes = boxes.map(|(add, remove)| Op::Mailboxes {
            mode,
            message_ids: vec![self.message_id.clone()],
            add,
            remove,
        });
        let value = |was: Option<bool>| if back { was } else { was.map(|value| !value) };
        let flags = (self.was_unread.is_some() || self.was_flagged.is_some()).then(|| Op::Flags {
            message_ids: vec![self.message_id.clone()],
            unread: value(self.was_unread),
            flagged: value(self.was_flagged),
        });
        [mailboxes, flags]
    }

    /// Each field the change set, and whether `now`, the message as it is, holds the change's
    /// value there. A message that is gone holds none.
    fn fields(&self, now: Option<&MessageState>) -> Vec<(UndoField, bool)> {
        let message_id = || self.message_id.clone();
        let member = |id: &MailboxId| now.is_some_and(|now| now.mailboxes.contains(id));
        let mailbox = |id: &MailboxId| UndoField::Mailbox {
            message_id: message_id(),
            mailbox_id: id.clone(),
        };
        let added = self.added.iter().map(|id| (mailbox(id), member(id)));
        let removed = self
            .removed
            .iter()
            .map(|id| (mailbox(id), now.is_some() && !member(id)));
        // The change set each flag to the other value than it had.
        let set = |was: bool, now: Option<bool>| now.is_some_and(|now| now != was);
        let unread = self.was_unread.map(|was| {
            let field = UndoField::Unread {
                message_id: message_id(),
            };
            (field, set(was, now.map(|now| now.unread)))
        });
        let flagged = self.was_flagged.map(|was| {
            let field = UndoField::Flagged {
                message_id: message_id(),
            };
            (field, set(was, now.map(|now| now.flagged)))
        });
        added.chain(removed).chain(unread).chain(flagged).collect()
    }

    /// The first field that no longer holds what the change set, given the message as the user
    /// sees it now, or None for a message that is gone, whose fields then all count.
    fn unheld(&self, now: Option<&MessageState>) -> Option<UndoField> {
        self.fields(now)
            .into_iter()
            .find(|(_, holds)| !holds)
            .map(|(field, _)| field)
    }
}

impl MessageEffect {
    /// The effect of `ops` on the messages as the user sees them now, pending changes included,
    /// on an account whose mailboxes change by `mode`. `undoes` names the change it reverses,
    /// when it is an undo.
    pub fn new(world: &World, mode: MailboxMode, ops: &[Op], undoes: Option<ChangeId>) -> MessageEffect {
        let pending = Pending::of(world);
        let named: IndexSet<&MessageId> = ops.iter().flat_map(Op::message_ids).collect();
        let altered: Vec<Altered> = named
            .into_iter()
            .filter_map(|id| world.messages.get(id))
            .filter_map(|record| {
                let before = pending.view_state(record);
                let after = ops
                    .iter()
                    .fold(before.clone().into_owned(), |state, op| overlay(&state, op, &record.id));
                let changed = |value: bool, now: bool| (value != now).then_some(value);
                let altered = Altered {
                    message_id: record.id.clone(),
                    added: after
                        .mailboxes
                        .iter()
                        .filter(|id| !before.mailboxes.contains(id))
                        .cloned()
                        .collect(),
                    removed: before
                        .mailboxes
                        .iter()
                        .filter(|id| !after.mailboxes.contains(id))
                        .cloned()
                        .collect(),
                    was_unread: changed(before.unread, after.unread),
                    was_flagged: changed(before.flagged, after.flagged),
                };
                let untouched = altered.added.is_empty()
                    && altered.removed.is_empty()
                    && altered.was_unread.is_none()
                    && altered.was_flagged.is_none();
                (!untouched).then_some(altered)
            })
            .collect();
        MessageEffect {
            ops: ops_for(&altered, mode, false),
            altered,
            reached: false,
            unconfirmed: false,
            refreshed: false,
            undoes,
        }
    }

    pub fn reached(&self) -> bool {
        self.reached
    }

    pub fn unconfirmed(&self) -> bool {
        self.unconfirmed
    }

    pub fn refreshed(&self) -> bool {
        self.refreshed
    }

    /// The same effect with each flag set as given (see the fields).
    pub fn with(self, reached: bool, unconfirmed: bool, refreshed: bool) -> MessageEffect {
        MessageEffect {
            reached,
            unconfirmed,
            refreshed,
            ..self
        }
    }

    /// How much of this change the provider holds, as it last reported, pending changes left out.
    pub fn landed(&self, world: &World) -> Landed {
        let fields: Vec<bool> = self
            .altered
            .iter()
            .filter_map(|altered| world.messages.get(&altered.message_id).map(|record| (altered, record)))
            .flat_map(|(altered, record)| altered.fields(Some(&record.server)))
            .map(|(_, holds)| holds)
            .collect();
        match (
            fields.is_empty(),
            fields.iter().all(|holds| *holds),
            fields.contains(&true),
        ) {
            (true, _, _) => Landed::Gone,
            (false, true, _) => Landed::All,
            (false, false, true) => Landed::Some,
            (false, false, false) => Landed::None,
        }
    }

    /// The Ops that put back what this change altered, and nothing else. Refused with the
    /// mailbox when it would put a message back in one that no longer exists.
    pub fn reversal(&self, world: &World, mode: MailboxMode) -> Result<Vec<Op>, UndoConflict> {
        let restored = self.altered.iter().flat_map(|altered| &altered.removed);
        if let Some(gone) = restored.into_iter().find(|id| !world.mailboxes.contains_key(*id)) {
            return Err(UndoConflict::MailboxGone {
                mailbox_id: gone.clone(),
            });
        }
        Ok(ops_for(&self.altered, mode, true))
    }
}

/// The Ops that set every altered field as the change left it, or as it was if `back`.
/// Messages that need the same values share one Op.
fn ops_for(altered: &[Altered], mode: MailboxMode, back: bool) -> Vec<Op> {
    let mut ops: Vec<Op> = Vec::new();
    for op in altered.iter().flat_map(|altered| altered.ops(mode, back)).flatten() {
        join(&mut ops, op);
    }
    ops
}

/// Adds the messages `op` names to the Op in `ops` that sets what it sets, or adds `op` itself.
fn join(ops: &mut Vec<Op>, mut op: Op) {
    fn ids_of(op: &mut Op) -> &mut Vec<MessageId> {
        match op {
            Op::Flags { message_ids, .. } | Op::Mailboxes { message_ids, .. } => message_ids,
        }
    }
    let ids = std::mem::take(ids_of(&mut op));
    let sets_the_same = |existing: &&mut Op| {
        let mut bare = (**existing).clone();
        ids_of(&mut bare).clear();
        bare == op
    };
    match ops.iter_mut().find(sets_the_same) {
        Some(existing) => ids_of(existing).extend(ids),
        None => {
            *ids_of(&mut op) = ids;
            ops.push(op);
        }
    }
}

/// Turn corrections. Build one with `TurnEffect::new`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnEffect {
    altered: Vec<TurnAltered>,
    undoes: Option<ChangeId>,
}

/// One conversation whose turn a correction changed: the turn the user had set before, and
/// the one it set (None: the rule's), and when its newest message the provider held was sent
/// then: empty when it held none. None for a change recorded before this was kept, whose undo
/// then cannot tell whether the conversation moved, and checks only the turn.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnAltered {
    thread_id: ThreadId,
    was: Option<Turn>,
    now: Option<Turn>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    newest: Option<Time>,
}

impl TurnEffect {
    /// The effect of setting each thread's turn to its value. `undoes` as for `MessageEffect::new`.
    pub fn new(world: &World, sets: &[(ThreadId, Option<Turn>)], undoes: Option<ChangeId>) -> TurnEffect {
        let altered = sets
            .iter()
            .filter_map(|(id, value)| {
                let newest = newest_held(world, id);
                let was = held_override(world.threads.get(id)?, newest.as_ref());
                (was != *value).then(|| TurnAltered {
                    thread_id: id.clone(),
                    was,
                    now: *value,
                    newest: Some(newest.unwrap_or_default()),
                })
            })
            .collect();
        TurnEffect { altered, undoes }
    }

    /// The turn each conversation this change altered had before.
    pub fn reversal(&self) -> Vec<(ThreadId, Option<Turn>)> {
        self.altered
            .iter()
            .map(|altered| (altered.thread_id.clone(), altered.was))
            .collect()
    }
}

/// Reads a change record's effect, or the `op` a store from before effects saved in its place.
pub fn effect_or_earlier<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Effect, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Stored {
        Now(Effect),
        Earlier(Option<Op>),
    }
    Ok(match Stored::deserialize(deserializer)? {
        Stored::Now(effect) => effect,
        Stored::Earlier(op) => Effect::Unrecorded { op },
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::Effect;
    use crate::world::ChangeRecord;

    /// A store written before effects must still open: its change records hold `op`.
    #[test]
    fn a_store_from_before_effects_still_loads() {
        let record = |op: serde_json::Value| {
            let value =
                json!({ "id": "change_1", "accountId": "account_1", "op": op, "acceptedRev": 3, "outcome": null });
            serde_json::from_value::<ChangeRecord>(value).map(|record| record.effect)
        };
        let flags = json!({ "kind": "flags", "messageIds": ["message_1"], "unread": false });
        let moved = json!({ "kind": "mailboxes", "mode": "sets", "messageIds": ["message_1"], "add": [], "remove": ["mailbox_1"] });
        let sent = json!({ "kind": "send", "messageId": "message_2", "stage": { "stage": "due" }, "raw": "", "bcc": [], "headerId": "a@b", "replyTo": null });
        assert!(matches!(record(flags), Ok(Effect::Unrecorded { op: Some(_) })));
        assert!(matches!(record(moved), Ok(Effect::Unrecorded { op: Some(_) })));
        assert!(matches!(record(json!(null)), Ok(Effect::Unrecorded { op: None })));
        assert!(matches!(record(sent), Ok(Effect::Send(_))));
    }
}
