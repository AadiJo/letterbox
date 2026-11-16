//! The push: carries an account's pending changes to the provider, one step at a time, and
//! settles each. What a change may hold at the provider is saved before each call, so an
//! undo reverses what may have gone through and cancels what surely did not (undo.rs).

use std::rc::Rc;

use letterbox_protocol::{AccountId, ChangeId, ChangeResult, CoreMessage, MessageId, Refusal};

use crate::adapter::{ApplyResult, Moved, ProviderRefusal};
use crate::changes::{overlay, plan};
use crate::effect::Effect;
use crate::maps::HashSet;
use crate::sync::PassResult;
use crate::world::{ChangeOutcome, ChangeRecord, MessageRecord, Op, Origin, put_change, put_message};
use crate::{Inner, Linked};

/// `change`, a change that failed, as the provider may hold it: with only what `applied`, the
/// parts that went through, and `partly`, the parts that may have, set. It stays reached when
/// any did, so an undo reverses exactly that (undo.rs). With none, nothing is left to undo.
fn failed_in_part(change: ChangeRecord, applied: &[Op], partly: &[Op]) -> ChangeRecord {
    match change.effect {
        Effect::Messages(effect) => ChangeRecord {
            effect: Effect::Messages(effect.applied_part(applied, partly)),
            ..change
        },
        _ => change,
    }
}

impl Inner {
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
        self.send(CoreMessage::Settled {
            change: id,
            rev,
            result,
        });
    }

    /// Carries every pending change for one account to the provider, oldest first. A send
    /// still in its undo window is passed by (see outbox.rs). Stops when the provider is
    /// unreachable. Unless `refreshed`, a change the provider may hold part of is passed by
    /// too, with every later change that names one of its messages: they may sit under refs
    /// only a refresh that has not ended yet tells the core (see `pass`).
    ///
    /// A change settles done only when every step went through, or found its messages gone.
    /// One a step turned away settles failed, and keeps only what the steps that went through
    /// set, so an undo takes back exactly that (effect.rs).
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
        let mut held: HashSet<MessageId> = HashSet::default();
        for id in waiting {
            if !self.still_current(account_id, linked) {
                return Ok(());
            }
            // Read again, since an undo may have cancelled it while an earlier change was on its way.
            let found = self.state.borrow().world.changes.get(&id).cloned();
            let Some(mut change) = found.filter(|change| change.outcome.is_none()) else {
                continue;
            };
            // True once the provider may hold part of it: from an earlier pass, or a call in this one.
            let was_reached = matches!(&change.effect, Effect::Messages(effect) if effect.reached());
            if !refreshed && (was_reached || change.effect.named().any(|id| held.contains(id))) {
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
            let mut known = was_reached;
            // The parts of the change that went through, and of a step turned away after part of it did.
            let mut applied = Vec::new();
            let mut partly = Vec::new();
            let mut refused = None;
            let total = steps.len();
            let mut gone = 0;
            for step in steps {
                // Saved before the call: from here on the provider may take it, whatever the
                // answer, so an undo reverses it instead of cancelling it (undo.rs).
                change = self.set_reached(change, true);
                let outcome = adapter.apply(step.mutation).await;
                if !self.still_current(account_id, linked) {
                    return outcome.map(drop);
                }
                match outcome {
                    // It surely did not reach the provider (adapter rule 11), so unless an earlier
                    // call may have, the provider holds none of it.
                    Err(failure) => {
                        if !known {
                            self.set_reached(change, false);
                        }
                        return Err(failure);
                    }
                    // It may have. It stays reached, and a later pass sets the same values again.
                    Ok(ApplyResult::Unconfirmed { failure }) => return Err(failure),
                    // None of this step's messages exist any more (adapter rule 5). A change needs
                    // several steps when its messages need different values, so the rest go on.
                    Ok(ApplyResult::Refused {
                        reason: ProviderRefusal::UnknownTarget,
                        landed: false,
                    }) => gone += 1,
                    Ok(ApplyResult::Refused { reason, landed }) => {
                        // What may have gone through shows as gone through, so an undo takes
                        // it back. A later sync shows which part really did.
                        if landed {
                            self.lay_over(&step.message_ids, &step.part, &[]);
                            partly.push(step.part);
                        }
                        refused = Some(reason);
                        break;
                    }
                    Ok(ApplyResult::Applied { moved }) => {
                        known = true;
                        self.lay_over(&step.message_ids, &step.part, &moved);
                        applied.push(step.part);
                    }
                }
            }
            let refused = refused.or((total > 0 && gone == total).then_some(ProviderRefusal::UnknownTarget));
            let Some(reason) = refused else {
                self.settle(change, ChangeResult::Done);
                continue;
            };
            // A change an earlier pass may have carried in part may hold any of its values.
            if was_reached {
                partly = change.effect.ops().to_vec();
            }
            self.settle(
                failed_in_part(change, &applied, &partly),
                ChangeResult::Failed(reason.into()),
            );
        }
        Ok(())
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

    /// True when a change for the account has not settled and the provider may hold part of it.
    pub(crate) fn unsure(&self, account_id: &AccountId) -> bool {
        let state = self.state.borrow();
        state.world.changes.values().any(|change| {
            &change.account_id == account_id
                && change.outcome.is_none()
                && matches!(&change.effect, Effect::Messages(effect) if effect.reached())
        })
    }

    /// Saves whether the provider may hold part of `change`, a change to messages, and returns
    /// it as saved. Any other change is returned as it is.
    fn set_reached(self: &Rc<Self>, change: ChangeRecord, reached: bool) -> ChangeRecord {
        let Effect::Messages(effect) = &change.effect else {
            return change;
        };
        if effect.reached() == reached {
            return change;
        }
        let saved = ChangeRecord {
            effect: Effect::Messages(effect.clone().with_reached(reached)),
            ..change
        };
        self.commit(|world, tx, _| put_change(world, tx, saved.clone()));
        saved
    }
}
