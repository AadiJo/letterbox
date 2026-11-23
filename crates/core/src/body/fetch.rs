//! Remote images the user chose to show. The renderer never reaches the network, so the core
//! fetches each image a UI asks for (`Request::Image`) and sends its bytes the way it sends an
//! attachment's: `chunk` messages, then the response. The UI puts them in as a `data:` URL.
//!
//! The core fetches only a URL the pipeline listed as a remote image of that message, never a
//! tracker, and only while the message's images are shown. It goes through the `Web` the host
//! gives it (web.rs), one request per hop, and checks every hop itself: each must be https and
//! must not be a tracker (trackers.rs), and it gives up after MAX_REDIRECTS. What comes back
//! must be an image of at most MAX_BYTES. A message's images past MAX_IMAGES are not fetched.

use std::rc::Rc;

use letterbox_protocol::{Answer, ImageError, ImageFile, MessageId, RequestId, Response, ShowImages};
use url::Url;

use super::{shown, trackers};
use crate::Inner;
use crate::web::{Fetched, Web};

/// The most bytes one image may have. A newsletter's largest images are well under this.
const MAX_BYTES: usize = 5 * 1024 * 1024;

/// How many redirects one image may take.
const MAX_REDIRECTS: usize = 5;

/// How many of a message's remote images the core fetches. The pipeline lists no more (html.rs).
pub const MAX_IMAGES: usize = 100;

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
                    if shown(world, record) == ShowImages::Blocked {
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
        self.work.spawn_local(async move {
            let answer = follow(&*core.web, &url).await.map(|(mime, bytes)| {
                core.send_chunks(&id, &bytes);
                ImageFile {
                    mime,
                    size: bytes.len() as u64,
                }
            });
            core.respond(id, Response::Image(Answer::from(answer)));
        });
    }
}

/// Fetches `url`, following redirects that pass the checks above, and returns the image.
async fn follow(web: &dyn Web, url: &str) -> Result<(String, Vec<u8>), ImageError> {
    let mut next = Url::parse(url).map_err(|_| ImageError::Refused)?;
    for _ in 0..=MAX_REDIRECTS {
        if next.scheme() != "https" || trackers::by_url(&next).is_some() {
            return Err(ImageError::Refused);
        }
        match web.get(next.as_str(), MAX_BYTES).await {
            Fetched::Body { mime, bytes } if mime.starts_with("image/") => return Ok((mime, bytes)),
            Fetched::Body { .. } => return Err(ImageError::Refused),
            Fetched::Redirect { location } => next = next.join(&location).map_err(|_| ImageError::Refused)?,
            Fetched::TooLarge => return Err(ImageError::TooLarge),
            Fetched::Failed => return Err(ImageError::Unreachable),
        }
    }
    Err(ImageError::Refused)
}
