//! What each change does, and what it altered, so an undo takes back exactly that (undo.rs).
//!
//! Every change record carries one `Effect`. A change that alters messages or turns records,
//! when it is accepted, what it altered: for each message, the mailboxes it put it in and took
//! it out of, and the read and flag state it had, for the fields the change really changed.
//! The records are built only by `MessageEffect::new` and `TurnEffect::new`, which read the
//! world as the user sees it then, so no change is stored without them. A message the change
//! named but did not alter is left out, so its undo never touches it: undoing an archive puts
//! Inbox back on the messages that left it, never on sent or already archived mail.

use letterbox_protocol::{ChangeId, ChangeResult, MailboxId, MessageId, ThreadId, Turn};
use serde::{Deserialize, Deserializer, Serialize};

use crate::changes::{Pending, overlay};
use crate::maps::IndexSet;
use crate::outbox::Outbound;
use crate::world::{ChangeRecord, MailboxMode, Op, World};

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

    /// True when both changes altered one field: the same mailbox, read or flag state of
    /// one message, or the turn of one thread.
    fn overlaps(&self, other: &Effect) -> bool {
        match (self, other) {
            (Effect::Messages(mine), Effect::Messages(theirs)) => mine.altered.iter().any(|one| {
                let same = |other: &&Altered| other.message_id == one.message_id;
                theirs.altered.iter().filter(same).any(|other| one.overlaps(other))
            }),
            (Effect::Turns(mine), Effect::Turns(theirs)) => mine
                .altered
                .iter()
                .any(|one| theirs.altered.iter().any(|other| other.thread_id == one.thread_id)),
            _ => false,
        }
    }
}

/// A change to flags or mailboxes. Build one with `MessageEffect::new`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageEffect {
    ops: Vec<Op>,
    altered: Vec<Altered>,
    /// True once the provider may hold part of it: an undo then reverses it instead of cancelling.
    reached: bool,
    undoes: Option<ChangeId>,
}

/// What one change altered on one message: the mailboxes it added and removed, and the read
/// and flag state the message had before, for each of the two it changed.
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
    fn overlaps(&self, other: &Altered) -> bool {
        let mine: IndexSet<&MailboxId> = self.added.iter().chain(&self.removed).collect();
        other
            .added
            .iter()
            .chain(&other.removed)
            .any(|mailbox| mine.contains(mailbox))
            || (self.was_unread.is_some() && other.was_unread.is_some())
            || (self.was_flagged.is_some() && other.was_flagged.is_some())
    }
}

impl MessageEffect {
    /// The effect of `ops` on the messages as the user sees them now, pending changes
    /// included. `undoes` names the change it reverses, when it is an undo.
    pub fn new(world: &World, ops: Vec<Op>, undoes: Option<ChangeId>) -> MessageEffect {
        let pending = Pending::of(world);
        let named: IndexSet<&MessageId> = ops.iter().flat_map(Op::message_ids).collect();
        let altered = named
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
            ops,
            altered,
            reached: false,
            undoes,
        }
    }

    pub fn reached(&self) -> bool {
        self.reached
    }

    /// The same effect, marked as one the provider may hold part of.
    pub fn now_reached(self) -> MessageEffect {
        MessageEffect { reached: true, ..self }
    }

    /// The Ops that put back what this change altered on the messages still here, and
    /// nothing else. Messages that need the same values share one Op.
    pub fn reversal(&self, world: &World, mode: MailboxMode) -> Vec<Op> {
        let mut ops: Vec<Op> = Vec::new();
        for altered in self
            .altered
            .iter()
            .filter(|altered| world.messages.contains_key(&altered.message_id))
        {
            let back = match mode {
                MailboxMode::Sets => Some((altered.removed.clone(), altered.added.clone())),
                // A move put the message in one folder. It goes back to the one it left.
                MailboxMode::Move => altered
                    .removed
                    .first()
                    .filter(|_| !altered.added.is_empty())
                    .map(|source| (vec![source.clone()], altered.added.clone())),
            };
            if let Some((add, remove)) = back.filter(|(add, remove)| !add.is_empty() || !remove.is_empty()) {
                let op = Op::Mailboxes {
                    mode,
                    message_ids: vec![],
                    add,
                    remove,
                };
                join(&mut ops, op, &altered.message_id);
            }
            if altered.was_unread.is_some() || altered.was_flagged.is_some() {
                let op = Op::Flags {
                    message_ids: vec![],
                    unread: altered.was_unread,
                    flagged: altered.was_flagged,
                };
                join(&mut ops, op, &altered.message_id);
            }
        }
        ops
    }
}

/// Adds `id` to the Op in `ops` that sets what `op` sets, or adds `op` for it alone.
fn join(ops: &mut Vec<Op>, mut op: Op, id: &MessageId) {
    fn ids_of(op: &mut Op) -> &mut Vec<MessageId> {
        match op {
            Op::Flags { message_ids, .. } | Op::Mailboxes { message_ids, .. } => message_ids,
        }
    }
    let sets_the_same = |existing: &&mut Op| {
        let mut bare = (**existing).clone();
        ids_of(&mut bare).clear();
        bare == op
    };
    match ops.iter_mut().find(sets_the_same) {
        Some(existing) => ids_of(existing).push(id.clone()),
        None => {
            ids_of(&mut op).push(id.clone());
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

/// One thread whose turn a correction changed, and the turn the user had set before (None: the rule's).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnAltered {
    thread_id: ThreadId,
    was: Option<Turn>,
}

impl TurnEffect {
    /// The effect of setting each thread's turn to its value. `undoes` as for `MessageEffect::new`.
    pub fn new(world: &World, sets: &[(ThreadId, Option<Turn>)], undoes: Option<ChangeId>) -> TurnEffect {
        let altered = sets
            .iter()
            .filter_map(|(id, value)| {
                let was = world.threads.get(id)?.turn_override;
                (was != *value).then(|| TurnAltered {
                    thread_id: id.clone(),
                    was,
                })
            })
            .collect();
        TurnEffect { altered, undoes }
    }

    /// The turn each thread this change altered had before, for the threads still here.
    pub fn reversal(&self, world: &World) -> Vec<(ThreadId, Option<Turn>)> {
        self.altered
            .iter()
            .filter(|altered| world.threads.contains_key(&altered.thread_id))
            .map(|altered| (altered.thread_id.clone(), altered.was))
            .collect()
    }
}

/// True when a change accepted after `target`, and not failed or undone, altered a field
/// `target` altered. Undoing `target` would then overwrite that later change.
pub fn overwritten(world: &World, target: &ChangeRecord) -> bool {
    let in_effect = |change: &&ChangeRecord| {
        matches!(
            change.outcome.map(|outcome| outcome.result),
            None | Some(ChangeResult::Done)
        )
    };
    let later = world
        .changes
        .values()
        .skip_while(|change| change.id != target.id)
        .skip(1);
    later
        .filter(in_effect)
        .any(|change| target.effect.overlaps(&change.effect))
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
