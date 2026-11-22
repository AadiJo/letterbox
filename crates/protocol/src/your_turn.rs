//! The signal behind a notification: new mail from a person that makes it the user's turn.

use serde::Serialize;
use ts_rs::TS;

use crate::{Person, ThreadId};

/// A sync brought a message from a person, in the inbox, that leaves this conversation the
/// user's turn: it is the newest message, and the turn rule gives the turn to the user because
/// its sender wrote last. Sent once per conversation per sync. Never for a message a snapshot
/// lists, which is how the first sync, a backfill and a resync bring mail, never for mail from
/// a machine, and never for the user's own sends. A UI that notifies shows `from` and `subject`
/// only, and opens `thread_id` when the notification is chosen.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct YourTurn {
    pub thread_id: ThreadId,
    pub from: Person,
    pub subject: String,
}
