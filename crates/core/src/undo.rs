//! Undo: takes one change back, exactly. What each change altered is in its effect (effect.rs).
//!
//!   - A send follows its undo window (outbox.rs): inside it the send is cancelled, and after
//!     it the undo is refused `conflict`, since mail cannot be unsent.
//!   - A change the provider has none of is cancelled. It never goes out, the view falls back to
//!     what it was, and it settles `undone` in the commit that stores the undo, which settles `done`.
//!   - A change the provider may hold, all of it or part, is reversed by a new change: the undo
//!     itself. It puts back what the change altered on each message and nothing else, and goes
//!     through the pipeline like any change: shown at once, saved, carried in order, settled.
//!     "May hold" is saved with the change before each call to the provider, and kept through
//!     a lost answer or a restart (see `push` in sync.rs). A turn correction is reversed the
//!     same way, and settles at once.
//!   - It is refused `conflict`, naming the field, when a field the change set no longer holds
//!     what it set: a later change here or at the provider changed it, or its message or
//!     conversation is gone. Undoing it then would overwrite that change. It is refused
//!     `conflict`, naming the mailbox, when it would put a message back in a mailbox that is gone.
//!   - It is refused `conflict` when the change failed (the provider refused it, so it is rolled
//!     back already), or when an undo of it is pending or done, so a change is undone once.
//!   - It is refused `not-supported` for an undo, which cannot be undone itself, and for a change
//!     a core accepted before changes recorded what they altered.
//!   - The same undo sent twice has one effect, as every command does (guarantee 4).

use std::rc::Rc;

use letterbox_protocol::{ChangeId, ChangeResult, CoreMessage, Refusal, ThreadId, Turn, UndoConflict};

use crate::Inner;
use crate::changes::mode_of;
use crate::effect::Effect;
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
    if target.effect.undoes().is_some() {
        return refuse(Refusal::NotSupported);
    }
    if let Effect::Send(_) = target.effect {
        return Ok(Answer::Window);
    }
    if let Some(ChangeResult::Failed(_) | ChangeResult::Undone) = target.outcome.map(|outcome| outcome.result) {
        return refuse(Refusal::Conflict);
    }
    if undone(world, &target.id) {
        return refuse(Refusal::Conflict);
    }
    if let Some(conflict) = target.effect.conflict(world) {
        return Err((Refusal::Conflict, Some(conflict)));
    }
    match &target.effect {
        Effect::Turns(effect) => Ok(Answer::ReverseTurns(effect.reversal())),
        Effect::Messages(effect) if target.outcome.is_none() && !effect.reached() => Ok(Answer::Cancel),
        Effect::Messages(effect) => {
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

impl Inner {
    /// Answers `undo` of `target` (see the module docs).
    pub(crate) fn undo(self: &Rc<Self>, change: ChangeId, target: &ChangeId) {
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
