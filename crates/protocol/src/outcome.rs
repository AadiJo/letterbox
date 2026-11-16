//! How a command ends: why it was refused, and the last word on a change.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

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
