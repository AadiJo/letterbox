//! Sending: the draft a UI hands the core, and how far a sent message has got.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::{AccountId, ChangeId, MessageId, Refusal, Time};

/// A message for the core to send. `to`, `cc` and `bcc` hold bare addresses, for example
/// "ana@example.com". The core writes From, Date, Message-ID, In-Reply-To and References.
/// A new conversation has neither `in_reply_to` nor `forward_of`, a reply has the first, and
/// a forward the second. A draft with both is refused `invalid`.
#[derive(Clone, Debug, PartialEq, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Draft {
    pub account_id: AccountId,
    pub to: Vec<String>,
    pub cc: Vec<String>,
    pub bcc: Vec<String>,
    pub subject: String,
    pub text: String,
    /// Required, but may be null. `Option::deserialize` stops serde from reading a missing field as null.
    #[serde(deserialize_with = "Option::deserialize")]
    pub html: Option<String>,
    /// The message this answers. Required, but may be null for a new conversation.
    #[serde(deserialize_with = "Option::deserialize")]
    pub in_reply_to: Option<MessageId>,
    /// The message this forwards. The core adds the original below `text` (and `html`) in the
    /// usual "Forwarded message" form, and carries its attachments with their names and types,
    /// so a UI sends only what the user wrote. Leave it out for anything but a forward. A forward
    /// starts a conversation of its own: it does not answer the original, so it moves no turn
    /// there. Refused `unknown-target` when the core has no such message, or its body is gone,
    /// and `conflict` while its body has not loaded (it loads when its conversation is open).
    /// A forward of a send of the user's that the provider does not hold yet waits, `sending`,
    /// until it does. It fails `unknown-target` if that send fails, or if an attachment is gone
    /// by the time it goes out.
    #[serde(default, deserialize_with = "crate::present")]
    #[ts(optional)]
    pub forward_of: Option<MessageId>,
}

/// How far a message the user sent has got. Messages the provider holds have none.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(tag = "state", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum Delivery {
    /// In its undo window until `until`. An `undo` naming `change` cancels it until then.
    Held { change: ChangeId, until: Time },
    /// Out of its window and waiting for the provider. It can no longer be undone.
    Sending { change: ChangeId },
    /// The provider refused it. It stays in its conversation, so the user sees it did not go.
    Failed { change: ChangeId, reason: Refusal },
}
