//! Attachment bytes. A client asks for one file by its blob id (`Request::Attachment`) to
//! open or save it, and the core fetches it from the provider in the account's queue, as it
//! fetches a body.
//!
//! The core keeps no copy, so every request fetches the file again. The store loads every
//! record into memory at start (world.rs), so files there would cost memory on every start.
//! Opening or saving puts the file on the user's disk anyway. And a copy would have to follow
//! every sign-out and every message the provider removes, or deleted mail would linger.
//! The limit is MAX_BYTES: a file the body lists as larger is refused `too-large`, and the
//! provider is never asked for it. A file the body lists as smaller but whose bytes come back
//! larger is refused `too-large` too, with no chunks, so a UI never gets more than the limit.
//!
//! The bytes go out as `chunk` messages of at most CHUNK_BYTES each, in order, and then the
//! response. No line carries a whole large file.

use std::rc::Rc;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use letterbox_protocol::{
    AccountId, Answer, AttachmentError, AttachmentFile, BlobId, CoreMessage, MessageId, RequestId, Response,
};

use crate::adapter::{Adapter, AttachmentResult, BodyResult, MessageRef, Outcome, RemoteAttachment};
use crate::world::blob_id_of;
use crate::{Inner, State};

/// The largest attachment the core fetches or sends. An adapter holds a whole file in memory,
/// and the core holds it again while it sends the chunks, so the listed size bounds what one
/// fetch costs whenever the provider tells the truth. Gmail takes messages of at most 50 MB
/// with their encoding, so no Gmail attachment is refused.
const MAX_BYTES: u64 = 50 * 1024 * 1024;

/// The most bytes one `chunk` message carries. The protocol docs name this size.
const CHUNK_BYTES: usize = 64 * 1024;

/// What a fetch needs once the attachment is found.
struct Found {
    adapter: Rc<dyn Adapter>,
    r#ref: MessageRef,
    index: usize,
    /// The attachment as the stored body lists it. Its name and type go in the answer.
    listed: RemoteAttachment,
}

/// The message and the place in it that `blob_id_of` made `blob_id` from. None for an id it
/// could not have made, such as one with a leading zero or no place.
#[expect(
    clippy::disallowed_methods,
    reason = "reads back the message id blob_id_of put in a blob id"
)]
fn attachment_of(blob_id: &BlobId) -> Option<(MessageId, usize)> {
    let (message, place) = blob_id.as_str().strip_prefix("blob_")?.rsplit_once('_')?;
    let index = place.parse::<usize>().ok()?.checked_sub(1)?;
    let message_id = MessageId::minted(message);
    (blob_id_of(&message_id, index) == *blob_id).then_some((message_id, index))
}

/// The attachment `blob_id` names and how to fetch it, or why it cannot be fetched.
fn find(state: &State, blob_id: &BlobId) -> Result<(AccountId, Found), AttachmentError> {
    let (message_id, index) = attachment_of(blob_id).ok_or(AttachmentError::Gone)?;
    let record = state.world.messages.get(&message_id).ok_or(AttachmentError::Gone)?;
    let Some(BodyResult::Body { body }) = &record.body else {
        // A client learns a blob id from a body the core stored, and the core keeps a body
        // as long as its message. No body means the id was never the core's to give.
        return Err(AttachmentError::Gone);
    };
    let listed = body.attachments.get(index).ok_or(AttachmentError::Gone)?;
    if listed.size > MAX_BYTES {
        return Err(AttachmentError::TooLarge);
    }
    // A message in the outbox is not at the provider yet, so neither are its files.
    let r#ref = record.provider_ref().ok_or(AttachmentError::Gone)?;
    let linked = state.adapters.get(&record.account_id).ok_or(AttachmentError::Offline)?;
    let found = Found {
        adapter: Rc::clone(&linked.adapter),
        r#ref: r#ref.clone(),
        index,
        listed: listed.clone(),
    };
    Ok((record.account_id.clone(), found))
}

impl Inner {
    /// Answers an `attachment` request (dispatch.rs). One the core cannot fetch is answered
    /// at once. Otherwise the fetch waits its turn in the account's queue.
    pub(crate) fn attachment(self: &Rc<Self>, id: RequestId, blob_id: BlobId) {
        let found = find(&self.state.borrow(), &blob_id);
        let (account_id, found) = match found {
            Ok(found) => found,
            Err(error) => return self.respond(id, Response::Attachment(Answer::from(Err(error)))),
        };
        let core = Rc::clone(self);
        self.background(&account_id, async move {
            let result = found.adapter.attachment(found.r#ref, found.index).await;
            core.send_attachment(id, found.listed, result);
        });
    }

    /// Sends what one fetch brought: the bytes in chunks, then the response.
    fn send_attachment(&self, id: RequestId, listed: RemoteAttachment, result: Outcome<AttachmentResult>) {
        let answer = match result {
            // Whatever kept the provider from answering, the file cannot be had now. A body
            // that fails to load reads as offline the same way (subscriptions.rs).
            Err(_) => Err(AttachmentError::Offline),
            Ok(AttachmentResult::Gone) => Err(AttachmentError::Gone),
            // The provider listed it as smaller. What came is in memory already, but goes no further.
            Ok(AttachmentResult::Bytes(data)) if data.len() as u64 > MAX_BYTES => Err(AttachmentError::TooLarge),
            Ok(AttachmentResult::Bytes(data)) => {
                for chunk in data.chunks(CHUNK_BYTES) {
                    self.send(CoreMessage::Chunk {
                        id: id.clone(),
                        data: STANDARD.encode(chunk),
                    });
                }
                Ok(AttachmentFile {
                    name: listed.name,
                    mime: listed.mime,
                    size: data.len() as u64,
                })
            }
        };
        self.respond(id, Response::Attachment(Answer::from(answer)));
    }
}
