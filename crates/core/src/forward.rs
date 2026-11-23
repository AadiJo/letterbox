//! What a forward carries of its original beyond its text: the original's files, and which of
//! them the user took off. draft.rs makes it from the draft's `forward_of` and
//! `forward_without`. The outbox keeps it with the send, and fetches the files it carries
//! (`contents`) each time the send is about to go.

use letterbox_protocol::MessageId;
use serde::{Deserialize, Serialize};

use crate::adapter::{AdapterFailure, AttachmentResult, BodyResult, RemoteAttachment};
use crate::outbox::Outbound;
use crate::world::Origin;
use crate::{Inner, Linked};

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

/// What a forward's files come to when it is about to go.
pub(crate) enum Contents {
    /// The content of the files it carries, in order. Empty for a send with no files.
    Ready(Vec<Vec<u8>>),
    /// The original is a send of the user's that the provider does not hold yet. The forward
    /// stays due until it does.
    Waiting,
    /// The original, or one of its files, is gone, or the original's own send failed.
    Gone,
}

impl Inner {
    /// The content of a forward's files, fetched from the provider's copy of the original.
    /// Empty for any other send. A failure here means nothing was sent.
    pub(crate) async fn contents(&self, linked: &Linked, outbound: &Outbound) -> Result<Contents, AdapterFailure> {
        let Some(forward) = outbound
            .forward
            .as_ref()
            .filter(|forward| forward.carried().next().is_some())
        else {
            return Ok(Contents::Ready(Vec::new()));
        };
        let r#ref = {
            let state = self.state.borrow();
            let world = &state.world;
            let original = world.messages.get(&forward.of);
            match original.map(|record| (&record.origin, &record.body)) {
                None | Some((_, Some(BodyResult::Gone))) => return Ok(Contents::Gone),
                Some((Origin::Provider { r#ref }, _)) => r#ref.clone(),
                // Its send is on its way, so it gets a ref once the provider holds it (`waiting_on`).
                Some((Origin::Outbox { outbox }, _)) => {
                    let pending = world.changes.get(outbox).is_some_and(|send| send.outcome.is_none());
                    return Ok(if pending { Contents::Waiting } else { Contents::Gone });
                }
            }
        };
        let mut contents = Vec::with_capacity(forward.files.len());
        for (index, _) in forward.carried() {
            match linked.adapter.attachment(r#ref.clone(), index).await? {
                AttachmentResult::Bytes(bytes) => contents.push(bytes),
                AttachmentResult::Gone => return Ok(Contents::Gone),
            }
        }
        Ok(Contents::Ready(contents))
    }
}
