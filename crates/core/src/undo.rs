//! Undo: takes one change back, exactly. What each change altered is in its effect (effect.rs).
//!
//!   - A send follows its undo window (outbox.rs): inside it the send is cancelled, and after
//!     it the undo is refused `conflict`, since mail cannot be unsent.
//!   - A change the provider has none of is cancelled. It never goes out, the view falls back to
//!     what it was, and it settles `undone` in the commit that stores the undo, which settles `done`.
//!   - A change the provider may hold, all of it or part, is reversed by a new change: the undo
//!     itself. It puts back what the change altered on each message and nothing else, and goes
//!     through the pipeline like any change: shown at once, saved, carried in order, settled.
//!     A turn correction is reversed the same way, and settles at once.
//!   - It is refused `conflict` when a later change that has not failed or been undone altered
//!     a field the change altered, since undoing it would overwrite that change. It is refused
//!     `conflict` too when the change failed (the provider refused it, so it is rolled back
//!     already) or was undone already, so a change is undone once.
//!   - It is refused `not-supported` for an undo, which cannot be undone itself, and for a change
//!     a core accepted before changes recorded what they altered.
//!   - The same undo sent twice has one effect, as every command does (guarantee 4).

use std::rc::Rc;

use letterbox_protocol::{ChangeId, ChangeResult, CoreMessage, Refusal, ThreadId, Turn};

use crate::Inner;
use crate::changes::mode_of;
use crate::effect::{Effect, overwritten};
use crate::maps::HashSet;
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

/// How to undo `target`, or why it cannot be undone. `in_flight` holds the changes with a call
/// to the provider under way, which may land however the undo answers, so those are reversed.
fn answer(world: &World, in_flight: &HashSet<ChangeId>, target: &ChangeRecord) -> Result<Answer, Refusal> {
    if target.effect.undoes().is_some() {
        return Err(Refusal::NotSupported);
    }
    if let Effect::Send(_) = target.effect {
        return Ok(Answer::Window);
    }
    if let Some(ChangeResult::Failed(_) | ChangeResult::Undone) = target.outcome.map(|outcome| outcome.result) {
        return Err(Refusal::Conflict);
    }
    if overwritten(world, target) {
        return Err(Refusal::Conflict);
    }
    match &target.effect {
        Effect::Turns(effect) => Ok(Answer::ReverseTurns(effect.reversal(world))),
        Effect::Messages(effect)
            if target.outcome.is_none() && !effect.reached() && !in_flight.contains(&target.id) =>
        {
            Ok(Answer::Cancel)
        }
        Effect::Messages(effect) => {
            let account = world.accounts.get(&target.account_id).ok_or(Refusal::UnknownTarget)?;
            if !account.capabilities.modify {
                return Err(Refusal::NotPermitted);
            }
            Ok(Answer::Reverse(effect.reversal(world, mode_of(account))))
        }
        Effect::Send(_) | Effect::Cancel { .. } | Effect::Unrecorded { .. } => Err(Refusal::NotSupported),
    }
}

impl Inner {
    /// Answers `undo` of `target` (see the module docs).
    pub(crate) fn undo(self: &Rc<Self>, change: ChangeId, target: &ChangeId) {
        let found = {
            let state = self.state.borrow();
            let record = state.world.changes.get(target).cloned();
            record.map(|record| (answer(&state.world, &state.in_flight, &record), record))
        };
        let Some((answer, record)) = found else {
            let reason = Refusal::UnknownTarget;
            return self.send(CoreMessage::Rejected { change, reason });
        };
        let account_id = record.account_id.clone();
        match answer {
            Err(reason) => self.send(CoreMessage::Rejected { change, reason }),
            Ok(Answer::Window) => self.undo_send(change, record),
            Ok(Answer::Cancel) => self.cancel(change, record, |_, _| {}),
            Ok(Answer::Reverse(ops)) => self.accept_messages(change, account_id, ops, Some(target.clone())),
            Ok(Answer::ReverseTurns(sets)) => self.set_turns(change, account_id, &sets, Some(target.clone())),
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
