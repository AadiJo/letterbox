//! The Gmail adapter: sign-in with OAuth 2.0 for installed apps, and the mailbox over
//! the Gmail REST API (gmail/v1). It follows the adapter contract in
//! crates/core/src/adapter.rs. How Gmail maps onto it:
//!
//!   message ref   the Gmail message id, which never changes
//!   mailbox ref   the label id. System labels get their role and a readable name.
//!                 UNREAD and STARRED are the `unread` and `flagged` flags. IMPORTANT,
//!                 CHAT and the CATEGORY_ labels are not mailboxes.
//!   bulk          from the inbox tab: Promotions, Social, Updates and Forums are bulk.
//!   cursor        the history id from users.getProfile, taken before the first page,
//!                 plus a digest of the label list, which history.list does not cover.
//!   changes       users.history.list, then each named message's current labels.
//!                 An expired history id (404) is `cursor-expired`.
//!   apply         users.messages.modify for one message, batchModify for several.
//!                 Trash adds the TRASH label.
//!   send          users.messages.send with the core's message as base64url, in the thread
//!                 of the message it answers. A send that may have landed is never sent
//!                 again: `find` searches rfc822msgid: for it (send.rs).
//!   attachment    messages.get with format=full, then the content inline in the part, or
//!                 users.messages.attachments.get with the part's fresh attachmentId.
//!
//! Rate limits: a call Gmail refuses as over its rate limit waits and tries again, up to
//! a limit (api.rs). The wait comes from `GmailConfig::pause`, and `close` ends it.
//!
//! Tokens: the refresh token goes in the session string. The access token stays in memory
//! and is refreshed when a call is refused with 401, so nothing reads a clock. A refresh
//! refused with `invalid_grant` answers `needs-sign-in`.
//!
//! Every endpoint, the client id and secret, the loopback and the random source come from
//! `GmailConfig`, so the scenarios run against the fake server in
//! packages/sim-provider/src/gmail with repeatable consent URLs. A live run uses
//! `GmailConfig::google_from_env`.

mod adapter;
mod api;
mod config;
mod factory;
mod labels;
mod loopback;
mod message;
mod oauth;
mod send;
mod wire;

use std::rc::Rc;

use letterbox_core::adapter::AdapterFactory;

pub use crate::config::{CLIENT_ID_VAR, CLIENT_SECRET_VAR, GmailConfig, Loopback, Pause, Random};

/// The Gmail sign-in option: id "gmail", label "Gmail", method oauth. The host's tokio
/// runtime must have `enable_time` on, for the HTTP client (see `GmailFactory::new`) and
/// for `GmailConfig::google`'s pause.
pub fn gmail_factory(config: GmailConfig) -> Rc<dyn AdapterFactory> {
    Rc::new(factory::GmailFactory::new(config))
}
