//! Sending: users.messages.send with the message the core wrote, as base64url.
//! https://developers.google.com/workspace/gmail/api/guides/sending
//!
//! Gmail reads the recipients from the headers and leaves Bcc out of what it delivers, so
//! the message goes with its Bcc header. A reply joins its thread by `threadId`, which the
//! guide says needs the References and In-Reply-To headers and a matching Subject, all of
//! which the core writes. A send that may have gone through before (adapter rule 10) first
//! searches for its Message-ID with the `rfc822msgid:` operator.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE;
use letterbox_core::adapter::{AdapterFailure, MessageRef, Outcome, Outgoing, ProviderRefusal, SendResult};
use reqwest::StatusCode;

use crate::adapter::GmailAdapter;
use crate::api::CallError;
use crate::wire::{Message, MessageList, Send};

impl GmailAdapter {
    /// The id of a message Gmail holds with this Message-ID, if any. Spam and trash count:
    /// a copy there was still sent.
    async fn find_sent(&self, message_id: &str) -> Result<Option<String>, CallError> {
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

    async fn deliver(&self, outgoing: &Outgoing) -> Result<SendResult, CallError> {
        let sent = |id: String| SendResult::Sent {
            r#ref: MessageRef::new(id),
        };
        if outgoing.maybe_sent
            && let Some(id) = self.find_sent(&outgoing.message_id).await?
        {
            return Ok(sent(id));
        }
        let thread_id = self.thread_of(outgoing.reply_to.as_ref()).await?;
        let raw = URL_SAFE.encode(outgoing.raw_with_bcc());
        let body = Send {
            raw: &raw,
            thread_id: thread_id.as_deref(),
        };
        let message: Message = self.api.post_for("messages/send", &body).await?;
        Ok(sent(message.id))
    }

    pub(crate) async fn send_message(&self, outgoing: Outgoing) -> Outcome<SendResult> {
        let refused = |reason| Ok(SendResult::Refused { reason });
        if !self.modify {
            return refused(ProviderRefusal::NotPermitted);
        }
        match self.deliver(&outgoing).await {
            Ok(result) => Ok(result),
            Err(CallError::Failure(failure)) => Err(failure),
            // Over a usage limit, sending included, not refused: the core tries again later.
            Err(error) if error.is_usage_limit() => Err(AdapterFailure::ProviderError),
            Err(CallError::Status { status, .. }) => match status {
                StatusCode::BAD_REQUEST => refused(ProviderRefusal::RefusedByProvider),
                StatusCode::FORBIDDEN => refused(ProviderRefusal::NotPermitted),
                _ => Err(AdapterFailure::ProviderError),
            },
        }
    }
}
