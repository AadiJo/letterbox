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
    /// A send may or may not have reached the provider, and the core could not find it there.
    /// The core does not send it again: sending it again is the user's choice.
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

/// Why an undo was refused `conflict`, when one field or mailbox says why: something the
/// change set no longer holds what it set, changed since on this device or at the provider,
/// or the undo would put a message back in a mailbox that is gone.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum UndoConflict {
    /// The message is no longer in, or no longer out of, this mailbox, or it is gone.
    Mailbox {
        message_id: MessageId,
        mailbox_id: MailboxId,
    },
    /// The message's read state is no longer what the change set, or it is gone.
    Unread { message_id: MessageId },
    /// The message's flag is no longer what the change set, or it is gone.
    Flagged { message_id: MessageId },
    /// The conversation's turn is no longer what the change set, or it is gone, as when a
    /// merge moved it into another.
    Turn { thread_id: ThreadId },
    /// The undo would put a message back in this mailbox, which no longer exists.
    MailboxGone { mailbox_id: MailboxId },
}
