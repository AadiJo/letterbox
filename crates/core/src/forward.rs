//! What a forward carries of its original beyond its text: the original's files, and which of
//! them the user took off. draft.rs makes it from the draft's `forward_of` and
//! `forward_without`. The outbox keeps it with the send and fetches the files it carries.

use letterbox_protocol::MessageId;
use serde::{Deserialize, Serialize};

use crate::adapter::RemoteAttachment;

/// What a forward carries of its original beyond the text draft.rs wrote into it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Forward {
    /// The message it forwards.
    pub of: MessageId,
    /// The original's attachments in the order its body lists them, so each one's place is
    /// the index `Adapter::attachment` takes.
    pub files: Vec<RemoteAttachment>,
    /// The places in `files` of those the user took off the forward. It carries the rest.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub left_out: Vec<usize>,
}

impl Forward {
    /// The files the forward carries, each with its place among the original's.
    pub fn carried(&self) -> impl Iterator<Item = (usize, &RemoteAttachment)> {
        self.files
            .iter()
            .enumerate()
            .filter(|(index, _)| !self.left_out.contains(index))
    }
}
