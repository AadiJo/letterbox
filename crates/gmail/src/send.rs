//! Sending: users.messages.send with the message the core wrote, as base64url.
//! https://developers.google.com/workspace/gmail/api/guides/sending
//!
//! Gmail reads the recipients from the headers and leaves Bcc out of what it delivers, so
//! the message goes with its Bcc header. A reply joins its thread by `threadId`, which the
//! guide says needs the References and In-Reply-To headers and a matching Subject, all of
//! which the core writes.
//!
//! messages.send takes no idempotency key, so a send whose answer is lost may have landed.
//! Only a connection that was never made, or an answer that says the call was not taken
//! (a usage limit, 4xx), surely did not. Everything else answers `unconfirmed`, and the
//! core then looks the message up with the `rfc822msgid:` operator (`find_sent`) and
//! never sends it again (adapter rule 10).

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE;
use letterbox_core::adapter::{AdapterFailure, MessageRef, Outcome, Outgoing, ProviderRefusal, SendResult};
use reqwest::StatusCode;

use crate::adapter::GmailAdapter;
use crate::api::CallError;
use crate::wire::{Message, MessageList, Send};

/// What a messages.send call says about the message: the one place that decides. Only a
/// clean, fully read success is `sent`, and only a failure before the request arrived or an
/// answer that refuses it says it did not land. Everything else may have landed, so it is
/// `unconfirmed`, and the core looks the message up instead of sending it again.
fn sent(result: Result<Message, CallError>) -> Outcome<SendResult> {
    let refused = |reason| Ok(SendResult::Refused { reason });
    match result {
        Ok(message) => Ok(SendResult::Sent {
            r#ref: MessageRef::new(message.id),
        }),
        Err(CallError::Failure(failure)) => Err(failure),
        Err(CallError::Lost | CallError::Unreadable) => Ok(SendResult::Unconfirmed),
        // Over a usage limit, sending included: Gmail did not take it, so the core tries again later.
        Err(error) if error.is_usage_limit() => Err(AdapterFailure::ProviderError),
        Err(CallError::Status { status, .. }) => match status {
            StatusCode::BAD_REQUEST => refused(ProviderRefusal::RefusedByProvider),
            StatusCode::FORBIDDEN => refused(ProviderRefusal::NotPermitted),
            // A server error may come after the message was taken.
            status if status.is_server_error() => Ok(SendResult::Unconfirmed),
            _ => Err(AdapterFailure::ProviderError),
        },
    }
}

impl GmailAdapter {
    /// The id of a message Gmail holds with this Message-ID, if any. Spam and trash count:
    /// a copy there was still sent. Gmail's search can lag a send by a little, so an empty
    /// answer soon after one is not the last word (the core asks again across a window).
    pub(crate) async fn find_sent(&self, message_id: &str) -> Result<Option<String>, CallError> {
        let query = format!("rfc822msgid:{message_id}");
        let query = [("q", query.as_str()), ("includeSpamTrash", "true"), ("maxResults", "1")];
        let list: MessageList = self.api.get("messages", &query).await?;
        Ok(list.messages.into_iter().next().map(|listed| listed.id))
    }

    /// The thread of the message a reply answers. None when there is none, or Gmail no
    /// longer has it: the reply then starts a thread of its own there.
    async fn thread_of(&self, reply_to: Option<&MessageRef>) -> Result<Option<String>, CallError> {
        let Some(parent) = reply_to else { return Ok(None) };
        let found = self.message(parent.as_str(), &[("format", "minimal")]).await?;
        Ok(found.and_then(|message| message.thread_id))
    }

    pub(crate) async fn send_message(&self, outgoing: Outgoing) -> Outcome<SendResult> {
        if !self.modify {
            return Ok(SendResult::Refused {
                reason: ProviderRefusal::NotPermitted,
            });
        }
        // Nothing has been sent yet, so any failure here surely left the message unsent.
        let thread_id = self
            .thread_of(outgoing.reply_to.as_ref())
            .await
            .map_err(|error| error.failure())?;
        let raw = URL_SAFE.encode(outgoing.raw_with_bcc());
        let body = Send {
            raw: &raw,
            thread_id: thread_id.as_deref(),
        };
        sent(self.api.post_for("messages/send", &body).await)
    }
}
