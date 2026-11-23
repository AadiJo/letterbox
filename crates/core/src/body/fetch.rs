//! Remote images the user chose to show. The renderer never reaches the network, so the core
//! fetches each image a UI asks for (`Request::Image`) and sends its bytes the way it sends an
//! attachment's: `chunk` messages, then the response. The UI puts them in as a `data:` URL.
//!
//! The core fetches only a URL the pipeline listed as a remote image of that message, never a
//! tracker, and only while the message's images are shown: it checks that again before every
//! hop and before every chunk, so a block mid-fetch ends it as `blocked`. It goes through the
//! `Web` the host gives it (web.rs), one request per hop, and checks every hop itself: each must
//! be https and must not be a tracker (trackers.rs), and it gives up after MAX_REDIRECTS. The
//! host refuses a host whose address is not public. What comes back must be at most MAX_BYTES
//! and, by its first bytes, a PNG, JPEG, GIF, WebP or AVIF image (`sniff`): the type the server
//! claims is not trusted, and SVG, which can carry script and links, is refused. A message's
//! images past MAX_IMAGES are not fetched.

use std::rc::Rc;

use letterbox_protocol::{Answer, ImageError, ImageFile, MessageId, RequestId, Response, ShowImages};
use url::Url;

use super::{shown, trackers};
use crate::Inner;
use crate::web::Fetched;

/// The most bytes one image may have. A newsletter's largest images are well under this.
const MAX_BYTES: usize = 5 * 1024 * 1024;

/// How many redirects one image may take.
const MAX_REDIRECTS: usize = 5;

/// How many of a message's remote images the core fetches. The pipeline lists no more (html.rs).
pub const MAX_IMAGES: usize = 100;

/// The bytes one `chunk` message carries, as attachments.rs sends them.
const CHUNK_BYTES: usize = 64 * 1024;

impl Inner {
    /// Answers an `image` request (dispatch.rs). One the core will not fetch is answered at
    /// once. Otherwise the fetch runs as work of its own, outside the account's queue: it never
    /// reaches the provider.
    pub(crate) fn image(self: &Rc<Self>, id: RequestId, message_id: &MessageId, index: u64) {
        let url = {
            let world = &self.state.borrow().world;
            world
                .messages
                .get(message_id)
                .ok_or(ImageError::Gone)
                .and_then(|record| {
                    let processed = record.reading.current().ok_or(ImageError::Gone)?;
                    let index = usize::try_from(index).ok().filter(|index| *index < MAX_IMAGES);
                    let url = index
                        .and_then(|index| processed.remote.get(index))
                        .ok_or(ImageError::Gone)?;
                    if shown(record) == ShowImages::Blocked {
                        return Err(ImageError::Blocked);
                    }
                    Ok(url.clone())
                })
        };
        let url = match url {
            Ok(url) => url,
            Err(error) => return self.respond(id, Response::Image(Answer::from(Err(error)))),
        };
        let core = Rc::clone(self);
        let message_id = message_id.clone();
        self.work.spawn_local(async move {
            let answer = core.follow(&message_id, &url).await;
            let answer = match answer {
                Ok((mime, bytes)) => core.send_image(&id, &message_id, mime, &bytes),
                Err(error) => Err(error),
            };
            core.respond(id, Response::Image(Answer::from(answer)));
        });
    }

    /// Whether the message's images are still shown. None when the message is gone.
    fn still_shown(&self, message_id: &MessageId) -> Result<(), ImageError> {
        let state = self.state.borrow();
        let record = state.world.messages.get(message_id).ok_or(ImageError::Gone)?;
        match shown(record) {
            ShowImages::Blocked => Err(ImageError::Blocked),
            ShowImages::Message => Ok(()),
        }
    }

    /// Fetches `url`, following redirects that pass the checks above, and returns the image
    /// and its type, read from its bytes.
    async fn follow(&self, message_id: &MessageId, url: &str) -> Result<(&'static str, Vec<u8>), ImageError> {
        let mut next = Url::parse(url).map_err(|_| ImageError::Refused)?;
        for _ in 0..=MAX_REDIRECTS {
            self.still_shown(message_id)?;
            if next.scheme() != "https" || trackers::by_url(&next).is_some() {
                return Err(ImageError::Refused);
            }
            match self.web.get(next.as_str(), MAX_BYTES).await {
                Fetched::Body { bytes, .. } => {
                    return sniff(&bytes).map(|mime| (mime, bytes)).ok_or(ImageError::Refused);
                }
                Fetched::Redirect { location } => next = next.join(&location).map_err(|_| ImageError::Refused)?,
                Fetched::TooLarge => return Err(ImageError::TooLarge),
                Fetched::Refused => return Err(ImageError::Refused),
                Fetched::Failed => return Err(ImageError::Unreachable),
            }
        }
        Err(ImageError::Refused)
    }

    /// Sends a fetched image's bytes as chunks, checking before each one that its message's
    /// images are still shown, and returns what the response says of it.
    fn send_image(
        &self,
        id: &RequestId,
        message_id: &MessageId,
        mime: &'static str,
        bytes: &[u8],
    ) -> Result<ImageFile, ImageError> {
        for chunk in bytes.chunks(CHUNK_BYTES) {
            self.still_shown(message_id)?;
            self.send_chunks(id, chunk);
        }
        Ok(ImageFile {
            mime: mime.to_owned(),
            size: bytes.len() as u64,
        })
    }
}

/// The image type `bytes` start with, by its signature: PNG, JPEG, GIF, WebP or AVIF. None for
/// anything else, SVG included.
fn sniff(bytes: &[u8]) -> Option<&'static str> {
    let at = |offset: usize, signature: &[u8]| bytes.get(offset..offset + signature.len()) == Some(signature);
    if at(0, b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if at(0, b"\xff\xd8\xff") {
        Some("image/jpeg")
    } else if at(0, b"GIF87a") || at(0, b"GIF89a") {
        Some("image/gif")
    } else if at(0, b"RIFF") && at(8, b"WEBP") {
        Some("image/webp")
    } else if at(4, b"ftypavif") || at(4, b"ftypavis") {
        Some("image/avif")
    } else {
        None
    }
}
