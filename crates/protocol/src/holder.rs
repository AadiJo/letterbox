//! Where a send is: what the `change` live view answers.

use serde::Serialize;
use ts_rs::TS;

use crate::ThreadId;

/// The conversation holding the message that send `change` wrote, for a UI that has to find
/// it: the one a new message started, or the one the core merged it into. Live, so a merge
/// moves it. `thread_id` is null for a change that is not a send the core holds, and once the
/// message is gone, as after an undo. Once the provider holds the message it stays where it is.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ChangeHolder {
    pub thread_id: Option<ThreadId>,
}
