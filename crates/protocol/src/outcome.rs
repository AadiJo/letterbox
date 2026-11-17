//! How a command ends: why it was refused, and the last word on a change.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::{MailboxId, MessageId, ThreadId};

/// Why the core or the provider said no.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum Refusal {
    NotPermitted,
    NotSupported,
    UnknownTarget,
    Conflict,
    RefusedByProvider,
    Invalid,
    /// The provider may have taken it without saying so, and the core could not confirm it
    /// all: a send it could not find there, or a change a sync then showed only part of, or
    /// none. The core does not try it again: that is the user's choice.
    Unconfirmed,
}

/// The last word on a change: `"done"`, `"undone"` or `{"failed": refusal}` on the wire.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum ChangeResult {
    Done,
    Undone,
    Failed(Refusal),
}

/// One field a change set: a message's place in a mailbox, its read state or flag, or a
/// conversation's turn.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum UndoField {
    Mailbox {
        message_id: MessageId,
        mailbox_id: MailboxId,
    },
    Unread {
        message_id: MessageId,
    },
    Flagged {
        message_id: MessageId,
    },
    Turn {
        thread_id: ThreadId,
    },
}

/// Why an undo was refused `conflict`, when there is more to say. An undo trusts only what
/// the provider confirmed: the change's answers, or a sync after it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum UndoConflict {
    /// `field` no longer holds what the change set: changed since, on this device or at the
    /// provider, or gone with its message or conversation.
    Changed { field: UndoField },
    /// Only part of the change went through, as a sync since showed: `field` does not hold
    /// what the change set.
    PartlyApplied { field: UndoField },
    /// The provider has not confirmed what the change, or another change to its messages,
    /// did. The next sync will.
    OutcomeUnknown,
    /// The undo would put a message back in this mailbox, which no longer exists.
    MailboxGone { mailbox_id: MailboxId },
}
