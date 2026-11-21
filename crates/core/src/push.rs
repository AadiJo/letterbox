//! The push: carries an account's pending changes to the provider, one step at a time, and
//! settles each from the provider's answers. Before each call the change is saved as reached
//! and unconfirmed, and the answer clears unconfirmed. A change whose answer never came stays
//! unconfirmed, and a sync settles it from what the provider holds (`confirm`), never another
//! try. An undo trusts only what this confirmed (undo.rs).

use std::rc::Rc;

use letterbox_protocol::{AccountId, ChangeId, ChangeResult, CoreMessage, MessageId, Refusal};

use crate::adapter::{ApplyResult, Moved, ProviderRefusal};
use crate::changes::{overlay, plan};
use crate::effect::{Effect, Landed};
use crate::maps::HashSet;
use crate::sync::PassResult;
use crate::world::{ChangeOutcome, ChangeRecord, MessageRecord, Op, Origin, put_change, put_message};
use crate::{Inner, Linked};

impl Inner {
    /// Gives a change its last word, `result`, in one commit, then sends `settled`.
    pub(crate) fn settle(self: &Rc<Self>, change: ChangeRecord, result: ChangeResult) {
        let id = change.id.clone();
        let rev = self.commit(|world, tx, at| {
            put_change(
                world,
                tx,
                ChangeRecord {
                    outcome: Some(ChangeOutcome { rev: at, result }),
                    ..change
                },
            );
        });
        // A forward that waits for this send, now failed, fails with it (see outbox.rs).
        self.waiting_on(&id);
        self.send(CoreMessage::Settled {
            change: id,
            rev,
            result,
        });
    }

    /// Carries every pending change for one account to the provider, oldest first. A send
    /// still in its undo window is passed by (see outbox.rs). Stops when the provider is
    /// unreachable. An unconfirmed change is passed by, and unless `refreshed`, so is every
    /// later change that names one of its messages: they may sit under refs only a refresh
    /// that has not ended yet tells the core (see `pass`).
    ///
    /// A change settles done only when every step went through, or found its messages gone,
    /// and failed when a step was turned away.
    pub(crate) async fn push(self: &Rc<Self>, account_id: &AccountId, linked: &Linked, refreshed: bool) -> PassResult {
        let adapter = &linked.adapter;
        let waiting: Vec<ChangeId> = self
            .state
            .borrow()
            .world
            .changes
            .values()
            .filter(|change| &change.account_id == account_id && change.outcome.is_none())
            .map(|change| change.id.clone())
            .collect();
        // Every change the provider has not confirmed holds its messages, until a refresh
        // shows what it did: a change after it there may name refs it changed.
        let mut held: HashSet<MessageId> = HashSet::default();
        if !refreshed {
            let state = self.state.borrow();
            let uncertain = state.world.changes.values().filter(|change| uncertain(change));
            held.extend(uncertain.flat_map(|change| change.effect.named().cloned()));
        }
        for id in waiting {
            if !self.still_current(account_id, linked) {
                return Ok(());
            }
            // Read again, since an undo may have cancelled it while an earlier change was on its way.
            let found = self.state.borrow().world.changes.get(&id).cloned();
            let Some(mut change) = found.filter(|change| change.outcome.is_none()) else {
                continue;
            };
            let unconfirmed = matches!(&change.effect, Effect::Messages(effect) if effect.unconfirmed());
            if unconfirmed || (!refreshed && change.effect.named().any(|id| held.contains(id))) {
                held.extend(change.effect.named().cloned());
                continue;
            }
            if let Effect::Send(outbound) = change.effect.clone() {
                self.deliver(account_id, linked, change, outbound).await?;
                continue;
            }
            let planned = plan(&self.state.borrow().world, change.effect.ops());
            let Some(steps) = planned else {
                self.settle(change, ChangeResult::Failed(Refusal::UnknownTarget));
                continue;
            };
            // Until it settles or the pass lets go of it, an undo of it waits (undo.rs).
            let _carrying = self.carrying(&change.id);
            // True once a step went through: from an earlier pass, or a call in this one.
            let mut known = matches!(&change.effect, Effect::Messages(effect) if effect.reached());
            let mut refused = None;
            let total = steps.len();
            let mut gone = 0;
            for step in steps {
                // Saved before the call: from here on the provider may take it, whatever the
                // answer, and until an answer comes nobody knows whether it did.
                change = self.mark(change, true, true);
                let outcome = adapter.apply(step.mutation).await;
                if !self.still_current(account_id, linked) {
                    return outcome.map(drop);
                }
                match outcome {
                    // It surely did not reach the provider (adapter rule 11).
                    Err(failure) => {
                        self.mark(change, known, false);
                        return Err(failure);
                    }
                    // It may have. It stays unconfirmed until a sync shows what the provider holds.
                    Ok(ApplyResult::Unconfirmed { failure }) => return Err(failure),
                    // None of this step's messages exist any more (adapter rule 5). A change needs
                    // several steps when its messages need different values, so the rest go on.
                    Ok(ApplyResult::Refused {
                        reason: ProviderRefusal::UnknownTarget,
                        landed: false,
                    }) => {
                        change = self.mark(change, known, false);
                        gone += 1;
                    }
                    // Turned away. Part of it may have gone through first, which only a sync shows.
                    Ok(ApplyResult::Refused { reason, landed }) => {
                        known |= landed;
                        change = self.mark(change, known, false);
                        refused = Some(reason);
                        break;
                    }
                    Ok(ApplyResult::Applied { moved }) => {
                        known = true;
                        self.lay_over(&step.message_ids, &step.part, &moved);
                        change = self.mark(change, true, false);
                    }
                }
            }
            let refused = refused.or((total > 0 && gone == total).then_some(ProviderRefusal::UnknownTarget));
            let result = refused.map_or(ChangeResult::Done, |reason| ChangeResult::Failed(reason.into()));
            self.settle(change, result);
        }
        Ok(())
    }

    /// Settles, from what the provider holds now, each pending change whose answer never came,
    /// and marks each change that failed after part of it went through as refreshed. Call it
    /// once a refresh has brought the core in step with the provider, after those changes.
    /// A change settles done only when every field it set holds its value at the provider.
    pub(crate) fn confirm(self: &Rc<Self>, account_id: &AccountId) {
        let waiting: Vec<ChangeRecord> = self
            .state
            .borrow()
            .world
            .changes
            .values()
            .filter(|change| &change.account_id == account_id && uncertain(change))
            .cloned()
            .collect();
        for change in waiting {
            let Effect::Messages(effect) = &change.effect else {
                continue;
            };
            if change.outcome.is_some() {
                let effect = effect.clone().with(true, false, true);
                let saved = ChangeRecord {
                    effect: Effect::Messages(effect),
                    ..change
                };
                self.commit(|world, tx, _| put_change(world, tx, saved));
                continue;
            }
            let landed = effect.landed(&self.state.borrow().world);
            let result = match landed {
                Landed::All => ChangeResult::Done,
                Landed::Gone => ChangeResult::Failed(Refusal::UnknownTarget),
                Landed::Some | Landed::None => ChangeResult::Failed(Refusal::Unconfirmed),
            };
            let effect = effect.clone().with(landed == Landed::Some, false, true);
            let effect = Effect::Messages(effect);
            self.settle(ChangeRecord { effect, ..change }, result);
        }
    }

    /// Counts `id` as a change this pass is carrying until the returned guard drops.
    fn carrying(self: &Rc<Self>, id: &ChangeId) -> Carrying {
        self.state.borrow_mut().pushing.insert(id.clone());
        Carrying {
            core: Rc::clone(self),
            id: id.clone(),
        }
    }

    /// Lays `part`, the part of a change one step carried for `message_ids`, over what the
    /// provider reported, with the refs it replaced (`moved`): the provider holds it now.
    fn lay_over(self: &Rc<Self>, message_ids: &[MessageId], part: &Op, moved: &[Moved]) {
        self.commit(|world, tx, _| {
            for id in message_ids {
                let Some(record) = world.messages.get(id).cloned() else {
                    continue;
                };
                let Some(old) = record.provider_ref().cloned() else {
                    continue;
                };
                let r#ref = moved
                    .iter()
                    .find(|pair| pair.from == old)
                    .map_or(old, |pair| pair.to.clone());
                let server = overlay(&record.server, part, id);
                put_message(
                    world,
                    tx,
                    MessageRecord {
                        origin: Origin::Provider { r#ref },
                        server,
                        ..record
                    },
                );
            }
        });
    }

    /// True when the provider has not confirmed what a change for the account did (`uncertain`).
    pub(crate) fn unsure(&self, account_id: &AccountId) -> bool {
        let state = self.state.borrow();
        state
            .world
            .changes
            .values()
            .any(|change| &change.account_id == account_id && uncertain(change))
    }

    /// Saves whether the provider may hold part of `change`, a change to messages, and whether
    /// a call for it awaits its answer, and returns it as saved. Any other change is returned as it is.
    fn mark(self: &Rc<Self>, change: ChangeRecord, reached: bool, unconfirmed: bool) -> ChangeRecord {
        let Effect::Messages(effect) = &change.effect else {
            return change;
        };
        if (effect.reached(), effect.unconfirmed()) == (reached, unconfirmed) {
            return change;
        }
        let refreshed = effect.refreshed();
        let saved = ChangeRecord {
            effect: Effect::Messages(effect.clone().with(reached, unconfirmed, refreshed)),
            ..change
        };
        self.commit(|world, tx, _| put_change(world, tx, saved.clone()));
        saved
    }
}

/// A change a pass is carrying to the provider. Dropping it, once the change settles or the
/// pass lets go of it unsettled, answers each undo that waited for it (`release_undos`).
struct Carrying {
    core: Rc<Inner>,
    id: ChangeId,
}

impl Drop for Carrying {
    fn drop(&mut self) {
        self.core.state.borrow_mut().pushing.remove(&self.id);
        self.core.release_undos(&self.id);
    }
}

/// True when the provider has not confirmed what `change` did: pending with a call that never
/// answered, or failed after part of it may have gone through, with no sync since.
pub(crate) fn uncertain(change: &ChangeRecord) -> bool {
    let Effect::Messages(effect) = &change.effect else {
        return false;
    };
    match change.outcome.map(|outcome| outcome.result) {
        None => effect.unconfirmed(),
        Some(ChangeResult::Failed(_)) => effect.reached() && !effect.refreshed(),
        Some(ChangeResult::Done | ChangeResult::Undone) => false,
    }
}
