//! Commands: the user intents a UI sends, each answered `accepted` or `rejected`, then `settled`.

use serde::Deserialize;
use ts_rs::TS;

use crate::{ChangeId, Draft, MailboxId, MessageId, ShowImages, ThreadId, Turn, present};

/// A user intent. Every command but set-images acts on whole threads.
/// Only set-turn and set-images work with read-only access, because they never leave the device.
#[derive(Clone, Debug, PartialEq, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum Command {
    /// Correct the rule, or hand the thread back to it with `auto`. A turn set holds until the
    /// conversation gets a message sent after its newest one then, from anyone, once the provider
    /// holds it. Then the rule decides again: their reply to a conversation marked done is my turn.
    /// `none` is Done, and is how a turn in Let go? is let go: it leaves Your turn and Let go? both.
    SetTurn {
        thread_ids: Vec<ThreadId>,
        turn: TurnChoice,
    },
    SetFlags {
        thread_ids: Vec<ThreadId>,
        #[serde(default, deserialize_with = "present")]
        #[ts(optional)]
        unread: Option<bool>,
        #[serde(default, deserialize_with = "present")]
        #[ts(optional)]
        flagged: Option<bool>,
    },
    /// Archive is `remove: [inbox]`. A move is one add and one remove.
    SetMailboxes {
        thread_ids: Vec<ThreadId>,
        add: Vec<MailboxId>,
        remove: Vec<MailboxId>,
    },
    Trash {
        thread_ids: Vec<ThreadId>,
    },
    Send {
        draft: Draft,
    },
    /// Shows or blocks one message's remote images, and settles at once: it never leaves the
    /// device. The message then reports `show` in `body.images.shown`, and no other message
    /// changes. Refused `not-supported` for an undo.
    SetImages {
        message_id: MessageId,
        show: ShowImages,
    },
    /// Takes back one change, exactly. A change the provider has none of is cancelled: it
    /// never goes out, it settles `undone`, and the undo settles `done`. A change the provider
    /// may hold is reversed by the undo itself, a change of its own that settles like any other:
    /// each message the change altered gets back the mailboxes, read and flag state it changed,
    /// and nothing else. A turn correction is reversed at once, unless the conversation got a
    /// newer message since: then it is refused `conflict`, `changed`.
    ///
    /// An undo trusts only what the provider confirmed. A send is cancelled only inside its
    /// undo window, and refused `conflict` after it. Otherwise it is refused `conflict`, with
    /// the reason in `conflict`:
    ///   - `outcome-unknown` while the provider has not confirmed what the change did: a call
    ///     for it reached the provider and it has not settled, or it failed after part of it
    ///     went through and no sync has run since, or another such change touches its messages.
    ///   - `changed` when a field the change set no longer holds what it set: changed since,
    ///     here or at the provider, or its message or conversation is gone.
    ///   - `partly-applied` when it failed, and a sync since shows a field it set never took it.
    ///   - `mailbox-gone` when the undo would put a message back in a mailbox that is gone.
    ///
    /// Refused `conflict` with no reason when it failed before any of it went through (it is
    /// rolled back already), or an undo of it is pending or done. Refused `not-supported` for
    /// an undo, which cannot itself be undone. Sending the same undo twice has one effect
    /// (guarantee 4).
    Undo {
        change: ChangeId,
    },
}

/// The turn a set-turn command asks for: a fixed holder, or `auto` to hand it back to the rule.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum TurnChoice {
    Mine,
    Theirs,
    #[serde(rename = "none")]
    Nobody,
    Auto,
}

impl TurnChoice {
    /// The turn the user fixed, or None when the rule decides.
    pub fn fixed(self) -> Option<Turn> {
        match self {
            TurnChoice::Mine => Some(Turn::Mine),
            TurnChoice::Theirs => Some(Turn::Theirs),
            TurnChoice::Nobody => Some(Turn::Nobody),
            TurnChoice::Auto => None,
        }
    }
}
