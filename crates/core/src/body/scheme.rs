//! Which colors a UI shows a message's HTML in (`ColorScheme`): the choice of its sender, kept
//! by From address, in lowercase, per account, in the store's `senders` table. Every sender
//! starts dark. The choice reaches every message from that address, new mail too.
//!
//! Unlike showing images (see `shown` in mod.rs), a choice by address is safe here. The scheme
//! changes only how the frame paints HTML the core already holds: nothing is fetched and the
//! sender learns nothing. So someone who writes another sender's address in a From gains nothing
//! by it, and the From address needs no proof.

use std::rc::Rc;

use letterbox_protocol::{AccountId, ChangeId, ChangeResult, ColorScheme, CoreMessage, MessageId, Refusal};
use serde::{Deserialize, Serialize};

use crate::Inner;
use crate::effect::Effect;
use crate::world::{ChangeOutcome, ChangeRecord, MessageRecord, World, put_change, put_sender, scoped};

/// A sender's id in the store: its account, and its From address in lowercase.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct SenderKey(String);

impl SenderKey {
    pub fn of(account_id: &AccountId, address: &str) -> SenderKey {
        SenderKey(scoped(account_id, &address.to_lowercase()))
    }
}

impl AsRef<str> for SenderKey {
    fn as_ref(&self) -> &str {
        &self.0
    }
}

/// What the user chose for one sender.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SenderRecord {
    pub id: SenderKey,
    pub account_id: AccountId,
    /// The From address, in lowercase.
    pub address: String,
    pub colors: ColorScheme,
}

/// The scheme a message's HTML shows in: its sender's choice, or dark.
pub fn of(world: &World, record: &MessageRecord) -> ColorScheme {
    let key = SenderKey::of(&record.account_id, &record.facts.from.address);
    world
        .senders
        .get(&key)
        .map_or(ColorScheme::Dark, |sender| sender.colors)
}

impl Inner {
    /// Answers set-colors: keeps the choice for the sender of the message, and settles at once,
    /// since it never leaves the device. See `Command::SetColors`.
    pub(crate) fn set_colors(self: &Rc<Self>, change: ChangeId, message_id: &MessageId, colors: ColorScheme) {
        let record = self.state.borrow().world.messages.get(message_id).cloned();
        let Some(record) = record else {
            return self.reject(change, Refusal::UnknownTarget);
        };
        let rev = self.commit_then(
            |world, tx, at| {
                if of(world, &record) != colors {
                    let address = record.facts.from.address.to_lowercase();
                    let sender = SenderRecord {
                        id: SenderKey::of(&record.account_id, &address),
                        account_id: record.account_id.clone(),
                        address,
                        colors,
                    };
                    put_sender(world, tx, sender);
                }
                let outcome = Some(ChangeOutcome {
                    rev: at,
                    result: ChangeResult::Done,
                });
                let effect = Effect::Colors {
                    message_id: message_id.clone(),
                };
                put_change(
                    world,
                    tx,
                    ChangeRecord {
                        id: change.clone(),
                        account_id: record.account_id.clone(),
                        effect,
                        accepted_rev: at,
                        outcome,
                    },
                );
            },
            |rev| self.accepted(&change, rev),
        );
        self.send(CoreMessage::Settled {
            change,
            rev,
            result: ChangeResult::Done,
        });
    }
}
