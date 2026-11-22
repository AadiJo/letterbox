//! Where one conversation sits in a list, for a UI that opens a conversation from outside the
//! rows it has loaded, as from a notification, and scrolls its list there.

use serde::Serialize;
use ts_rs::TS;

/// The answer to `position`: how many conversations sort before this one in the list its
/// filter gives right now, newest first, so its row is at that offset. Null when that list
/// does not hold it, as for a conversation that is gone or does not pass the filter.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
pub struct Position {
    pub offset: Option<u64>,
}
