//! The bytes a message carries: an attachment's file, which a UI opens or saves, and the
//! local URL of an inline image.

use serde::Serialize;
use ts_rs::TS;

/// The answer to `attachment`, after its bytes. `size` is how many bytes the chunks carried.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
pub struct AttachmentFile {
    /// The file name the message gives. Hostile input: a UI that makes a path from it cleans it first.
    pub name: String,
    pub mime: String,
    pub size: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum AttachmentError {
    /// The provider could not be reached, or the account is not signed in.
    Offline,
    /// The message, or that attachment in it, no longer exists.
    Gone,
    /// Larger than the core fetches (see crates/core/src/attachments.rs).
    TooLarge,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
pub struct BlobUrl {
    pub url: String,
    pub mime: String,
    pub size: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum BlobError {
    Offline,
    Gone,
    NotSupported,
}
