//! Commands: the user intents a UI sends, each answered `accepted` or `rejected`, then `settled`.

use serde::Deserialize;
use ts_rs::TS;

use crate::{ChangeId, Draft, MailboxId, ThreadId, Turn, present};

/// A user intent. Every command acts on whole threads.
/// Only set-turn works with read-only access, because it never leaves the device.
#[derive(Clone, Debug, PartialEq, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum Command {
    /// Correct the rule, or hand the thread back to it with `auto`.
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
    /// Takes back one change, exactly. A change the provider has none of is cancelled: it
    /// never goes out, it settles `undone`, and the undo settles `done`. A change the provider
    /// may hold is reversed by the undo itself, a change of its own that settles like any other:
    /// each message the change altered gets back the mailboxes, read and flag state it changed,
    /// and nothing else. A turn correction is reversed at once.
    ///
    /// A send is cancelled only inside its undo window, and refused `conflict` after it. Refused
    /// `conflict` when a later change altered the same field of the same message or thread,
    /// when the change failed (it is rolled back already) or was undone already. Refused
    /// `not-supported` for an undo, which cannot itself be undone. Sending the same undo
    /// twice has one effect (guarantee 4).
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
