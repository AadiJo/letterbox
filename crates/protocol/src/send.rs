//! Sending: the draft a UI hands the core, and how far a sent message has got.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::{AccountId, ChangeId, MessageId, Refusal, Time};

/// A message for the core to send. `to`, `cc` and `bcc` hold bare addresses, for example
/// "ana@example.com". The core writes From, Date, Message-ID, In-Reply-To and References.
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
