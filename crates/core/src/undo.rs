//! Undo: takes one change back, exactly. What each change altered is in its effect (effect.rs).
//! It trusts only what the provider confirmed: a change's answers, or a sync after them.
//!
//!   - A send follows its undo window (outbox.rs): inside it the send is cancelled, and after
//!     it the undo is refused `conflict`, since mail cannot be unsent.
//!   - An undo of a change a pass is carrying waits until the pass settles it or lets go of
//!     it, then is answered by the rules below, so an undo pressed while its change is on its
//!     way reverses it once it lands.
//!   - A change no call has reached is cancelled. It never goes out, the view falls back to
//!     what it was, and it settles `undone` in the commit that stores the undo, which settles `done`.
//!   - A change the provider confirmed is reversed by a new change: the undo itself. It puts
//!     back what the change altered on each message and nothing else, and goes through the
//!     pipeline like any change. A turn correction is reversed the same way, and settles at once.
//!     It is refused `changed` once the conversation got a message sent after the change's newest
//!     one: the turn it set no longer holds (see `held_override` in turns.rs).
//!   - It is refused `conflict`, `outcome-unknown`, while the provider has not confirmed what
//!     the change did (`uncertain` in push.rs), or what another change to its messages did: a
//!     call reached the provider and the change has not settled, or it failed after part of it
//!     went through and no sync has run since.
//!   - Otherwise one rule decides: every field the change set must still hold what it set, as
//!     the user sees it now. Refused `conflict`, `changed`, naming the field, when one does not
//!     for a change that went through, and `partly-applied` for one that failed: only part of
//!     it went through. Refused `conflict`, `mailbox-gone`, when it would put a message back in
//!     a mailbox that is gone.
//!   - A change that failed before any of it went through is rolled back already, and its undo
//!     is refused `conflict`. So is the undo of a change an undo of which is pending or done,
//!     so a change is undone once.
//!   - It is refused `not-supported` for an undo, which cannot be undone itself, and for a change
//!     a core accepted before changes recorded what they altered.
//!   - The same undo sent twice has one effect, as every command does (guarantee 4).

use std::rc::Rc;

use letterbox_protocol::{
    ChangeId, ChangeResult, Command, CoreMessage, MessageId, Refusal, ThreadId, Turn, UndoConflict,
};

use crate::Inner;
use crate::changes::mode_of;
use crate::effect::Effect;
use crate::maps::HashSet;
use crate::push::uncertain;
use crate::store::Transaction;
use crate::world::{ChangeOutcome, ChangeRecord, Op, World, put_change};

/// How an undo answers, before anything is written.
enum Answer {
    /// A send: its window decides (see `undo_send` in outbox.rs).
    Window,
    Cancel,
    /// Accept these Ops as the undo, a change of its own.
    Reverse(Vec<Op>),
    /// Set each thread's turn back, as the undo.
    ReverseTurns(Vec<(ThreadId, Option<Turn>)>),
}

/// Why an undo is refused, and the field or mailbox that says why, when one does.
type Refused = (Refusal, Option<UndoConflict>);

/// How to undo `target`, or why it cannot be undone.
fn answer(world: &World, target: &ChangeRecord) -> Result<Answer, Refused> {
    let refuse = |reason| Err((reason, None));
    let unknown = || Err((Refusal::Conflict, Some(UndoConflict::OutcomeUnknown)));
    if target.effect.undoes().is_some() {
        return refuse(Refusal::NotSupported);
    }
    if let Effect::Send(_) = target.effect {
        return Ok(Answer::Window);
    }
    let failed = matches!(
        target.outcome.map(|outcome| outcome.result),
        Some(ChangeResult::Failed(_))
    );
    if matches!(target.outcome.map(|outcome| outcome.result), Some(ChangeResult::Undone)) || undone(world, &target.id) {
        return refuse(Refusal::Conflict);
    }
    match &target.effect {
        Effect::Turns(effect) => match target.effect.conflict(world) {
            Some(field) => Err((Refusal::Conflict, Some(UndoConflict::Changed { field }))),
            None => Ok(Answer::ReverseTurns(effect.reversal())),
        },
        Effect::Messages(effect) => {
            // Turned away before any of it went through: rolled back already.
            if failed && !effect.reached() {
                return refuse(Refusal::Conflict);
            }
            if uncertain(target) || (target.outcome.is_none() && effect.reached()) {
                return unknown();
            }
            if let Some(field) = target.effect.conflict(world) {
                let conflict = if failed {
                    UndoConflict::PartlyApplied { field }
                } else {
                    UndoConflict::Changed { field }
                };
                return Err((Refusal::Conflict, Some(conflict)));
            }
            if target.outcome.is_none() {
                return Ok(Answer::Cancel);
            }
            // The reversal is worked out from what the user sees of its messages, which must be
            // what the provider confirmed.
            if others_uncertain(world, target) {
                return unknown();
            }
            let account = world.accounts.get(&target.account_id);
            let account = account.ok_or((Refusal::UnknownTarget, None))?;
            if !account.capabilities.modify {
                return refuse(Refusal::NotPermitted);
            }
            let reversal = effect.reversal(world, mode_of(account));
            Ok(Answer::Reverse(
                reversal.map_err(|gone| (Refusal::Conflict, Some(gone)))?,
            ))
        }
        Effect::Send(_) | Effect::Cancel { .. } | Effect::Unrecorded { .. } => refuse(Refusal::NotSupported),
    }
}

/// True when another change to one of `target`'s messages has an outcome the provider has not confirmed.
fn others_uncertain(world: &World, target: &ChangeRecord) -> bool {
    let named: HashSet<&MessageId> = target.effect.named().collect();
    world.changes.values().any(|change| {
        change.id != target.id
            && (uncertain(change) || (change.outcome.is_none() && reached(change)))
            && change.effect.named().any(|id| named.contains(id))
    })
}

/// True when a call for `change`, a change to messages, may have reached the provider.
fn reached(change: &ChangeRecord) -> bool {
    matches!(&change.effect, Effect::Messages(effect) if effect.reached())
}

/// True when an undo of `target` is pending or done. One that failed leaves it to undo again.
fn undone(world: &World, target: &ChangeId) -> bool {
    world.changes.values().any(|change| {
        change.effect.undoes() == Some(target)
            && matches!(
                change.outcome.map(|outcome| outcome.result),
                None | Some(ChangeResult::Done)
            )
    })
}

/// An undo that waits for its change, which a pass is carrying, to settle or be let go of.
/// Its id is taken, so the same undo sent again waits with it (`resent`) and gets the answer too.
pub(crate) struct HeldUndo {
    change: ChangeId,
    target: ChangeId,
    resent: usize,
}

impl Inner {
    /// Answers `undo` of `target` (see the module docs). While a pass is carrying `target`, its
    /// outcome is on its way, so the undo waits for it (`release_undos`) instead of answering
    /// now. The pass may yet settle it, or leave it waiting, all of it or part.
    pub(crate) fn undo(self: &Rc<Self>, change: ChangeId, target: &ChangeId) {
        {
            let mut state = self.state.borrow_mut();
            if state.pushing.contains(target) {
                let target = target.clone();
                state.held_undos.push(HeldUndo {
                    change,
                    target,
                    resent: 0,
                });
                return;
            }
        }
        let found = {
            let state = self.state.borrow();
            let record = state.world.changes.get(target).cloned();
            record.map(|record| (answer(&state.world, &record), record))
        };
        let Some((answer, record)) = found else {
            return self.reject(change, Refusal::UnknownTarget);
        };
        let account_id = record.account_id.clone();
        match answer {
            Err((reason, conflict)) => self.send(CoreMessage::Rejected {
                change,
                reason,
                conflict,
            }),
            Ok(Answer::Window) => self.undo_send(change, record),
            Ok(Answer::Cancel) => self.cancel(change, record, |_, _| {}),
            Ok(Answer::Reverse(ops)) => self.accept_messages(change, account_id, ops, Some(target.clone())),
            Ok(Answer::ReverseTurns(sets)) => self.set_turns(change, account_id, &sets, Some(target.clone())),
        }
    }

    /// True when `change` is an undo still waiting for its change. It is answered once more
    /// when that ends, as a command sent twice is (guarantee 4).
    pub(crate) fn resent_while_held(&self, change: &ChangeId) -> bool {
        let mut state = self.state.borrow_mut();
        let held = state.held_undos.iter_mut().find(|held| &held.change == change);
        held.map(|held| held.resent += 1).is_some()
    }

    /// Answers each undo that waited for `target`, which a pass no longer carries: it settled,
    /// or the pass ended with it unsettled. The rules decide as for any undo.
    pub(crate) fn release_undos(self: &Rc<Self>, target: &ChangeId) {
        let released: Vec<HeldUndo> = {
            let mut state = self.state.borrow_mut();
            let (released, kept) = std::mem::take(&mut state.held_undos)
                .into_iter()
                .partition(|held| &held.target == target);
            state.held_undos = kept;
            released
        };
        for held in released {
            self.undo(held.change.clone(), &held.target);
            for _ in 0..held.resent {
                let command = Command::Undo {
                    change: held.target.clone(),
                };
                self.on_command(held.change.clone(), command);
            }
        }
    }

    /// Cancels `target`, which the provider has none of, with the undo `change`. One commit runs
    /// `also`, settles `target` undone, and stores the undo, settled done. Its effect drops out
    /// of what the user sees in that commit, and a pass that comes to it later passes it by.
    pub(crate) fn cancel(
        self: &Rc<Self>,
        change: ChangeId,
        target: ChangeRecord,
        also: impl FnOnce(&mut World, &Transaction<'_>),
    ) {
        let of = target.id.clone();
        let rev = self.commit_then(
            |world, tx, at| {
                also(world, tx);
                let settled = |result| Some(ChangeOutcome { rev: at, result });
                let undo = ChangeRecord {
                    id: change.clone(),
                    account_id: target.account_id.clone(),
                    effect: Effect::Cancel { of: of.clone() },
                    accepted_rev: at,
                    outcome: settled(ChangeResult::Done),
                };
                let outcome = settled(ChangeResult::Undone);
                put_change(world, tx, ChangeRecord { outcome, ..target });
                put_change(world, tx, undo);
            },
            |rev| self.accepted(&change, rev),
        );
        let undone = ChangeResult::Undone;
        self.send(CoreMessage::Settled {
            change: of,
            rev,
            result: undone,
        });
        self.send(CoreMessage::Settled {
            change,
            rev,
            result: ChangeResult::Done,
        });
    }
}
