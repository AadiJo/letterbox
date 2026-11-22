//! The adapter contract: everything the core asks of one mail provider.
//!
//! An adapter speaks one provider's protocol and reports that mailbox in the
//! shapes below. It holds no mail and makes no decisions. The core owns the
//! store, the threads, the turn rule and the queue of pending changes.
//!
//! Rules every adapter follows. The conformance scenarios in the harness check them.
//!   1. Expected failures come back as values, never as panics. Panic only for bugs.
//!   2. `snapshot` takes its cursor before it lists the first page. A change made
//!      while the core is paging then comes back from the next `changes` call.
//!   3. `changes` may repeat something the core already has. The core applies
//!      changes so that a repeat is harmless.
//!   4. A ref names one message for as long as the provider keeps it in place.
//!      A provider with plain folders may give a moved message a new ref. It then
//!      reports the old ref as removed and the new one as added in the same result.
//!   5. `apply` skips refs that no longer exist. It answers `unknown-target` only
//!      when none of them exist, and only for messages: a mailbox it names that does not
//!      exist is `unknown-mailbox`, a refusal of the whole call.
//!   6. `apply` sets values, so applying the same mutation twice is harmless
//!      wherever the provider keeps refs stable.
//!   7. No method reads or writes anything outside the provider. Adapters keep
//!      their resume point in the cursor and their login in the session string.
//!   8. `snapshot` answers `page-expired` when the provider no longer accepts the page
//!      token. The core then lists the mailbox again from the first page.
//!   9. Snapshot pages list the newest mail first, so the core can show recent mail
//!      while it backfills the rest. Gmail's messages.list already does: "The returned
//!      `messages` objects are listed in reverse chronological order (newest first)."
//!      <https://developers.google.com/workspace/gmail/api/guides/list-messages>
//!  10. `send` delivers the message as the core wrote it, to its To and Cc addresses and to
//!      `bcc`, keeps a copy where the provider keeps sent mail, and answers with that copy's
//!      ref. Later `changes` and snapshots report the copy under that ref. It answers
//!      `offline` (or another failure) only when the message surely did not reach the
//!      provider, such as when no connection was made, and `unconfirmed` when it may have.
//!      A provider offers no way to send a message only once, so after `unconfirmed`, or a
//!      core that stopped during the call, the core never calls `send` for it again. It calls
//!      `find` with its Message-ID instead (see outbox.rs).
//!  11. `apply` answers a failure only when the mutation surely did not reach the provider,
//!      or the provider turned it away before acting on it. It answers `unconfirmed` when the
//!      provider may have acted on it, all of it or part: the request went out and no whole
//!      answer came back, the provider failed while handling it, or an earlier call for it
//!      went through. After a failure the core tries it again later, since `apply` sets
//!      values (rule 6). After `unconfirmed` it does not: a sync settles the change from what
//!      the provider holds (push.rs), and until then an undo of it waits (undo.rs). An adapter that splits
//!      one call into several requests, and has one turned away after an earlier one went
//!      through, answers `refused` with `landed`: the core settles it failed, and only a sync
//!      shows which part went through.
//!
//! The core runs on one thread, so adapters and their futures need not be `Send`.

use std::future::Future;
use std::pin::Pin;
use std::rc::Rc;

use letterbox_protocol::{Capabilities, PasswordInput, Refusal, Role, SignInError, SignInMethod, Time};
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

/// A boxed future that stays on the core's thread. Every adapter method returns one.
pub type LocalFuture<'a, T> = Pin<Box<dyn Future<Output = T> + 'a>>;

/// Declares opaque strings minted by an adapter. The core stores them and hands them back.
macro_rules! refs {
    ($($(#[$doc:meta])* $name:ident),* $(,)?) => {$(
        $(#[$doc])*
        #[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(String);

        impl $name {
            pub fn new(value: impl Into<String>) -> Self {
                Self(value.into())
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }
        }
    )*};
}

refs!(
    /// Names one message at the provider. See rule 4 for when it can change.
    MessageRef,
    /// Names one folder or label at the provider.
    MailboxRef,
    /// Where the next `changes` call resumes. It can be large, for example a list of known ids.
    Cursor,
    /// Where the next `snapshot` call resumes.
    PageToken,
);

/// The core turns these into the `can` field the UI reads.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterCapabilities {
    /// False for read-only access. The core then never calls `apply` or `send`.
    pub modify: bool,
    /// False when the provider cannot send. The core then never calls `send`.
    pub send: bool,
    /// True where one message can sit in several mailboxes at once.
    pub multiple_mailboxes: bool,
}

impl From<AdapterCapabilities> for Capabilities {
    fn from(can: AdapterCapabilities) -> Self {
        Capabilities {
            modify: can.modify,
            send: can.send,
            multiple_mailboxes: can.multiple_mailboxes,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct RemoteMailbox {
    pub r#ref: MailboxRef,
    pub name: String,
    pub role: Option<Role>,
    pub parent: Option<MailboxRef>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RemoteAddress {
    pub name: Option<String>,
    pub address: String,
}

/// The part of a message that other devices can change.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct RemoteState {
    pub r#ref: MessageRef,
    /// Exactly one entry when `multiple_mailboxes` is false.
    pub mailboxes: Vec<MailboxRef>,
    pub unread: bool,
    pub flagged: bool,
}

/// The part of a message that never changes after delivery.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteFacts {
    /// The Message-ID header without angle brackets, or None if the message has none.
    pub message_id: Option<String>,
    /// Message-IDs from In-Reply-To and References, oldest first, without angle brackets.
    pub references: Vec<String>,
    pub subject: String,
    pub from: RemoteAddress,
    pub to: Vec<RemoteAddress>,
    pub cc: Vec<RemoteAddress>,
    pub sent_at: Time,
    /// The start of the plain text, at most 200 characters, with quoted replies left out.
    pub preview: String,
    /// Size in bytes as the provider reports it.
    pub size: u64,
    pub has_attachments: bool,
    /// Raw header facts the turn rule reads.
    pub headers: RemoteHeaders,
    /// The provider's own verdict that this is bulk mail. None when it gives none.
    pub bulk: Option<bool>,
}

/// Empty string when the header is absent.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteHeaders {
    pub list_unsubscribe: bool,
    pub list_id: bool,
    pub precedence: String,
    pub auto_submitted: String,
    /// List-Unsubscribe's value (RFC 2369), which body/unsubscribe.rs reads. Messages stored
    /// before it was kept have only `list_unsubscribe`.
    #[serde(default)]
    pub list_unsubscribe_value: String,
    /// List-Unsubscribe-Post's value (RFC 8058).
    #[serde(default)]
    pub list_unsubscribe_post: String,
}

/// A whole message as the provider lists it: its state and its facts side by side in one JSON object.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct RemoteMessage {
    #[serde(flatten)]
    pub state: RemoteState,
    #[serde(flatten)]
    pub facts: RemoteFacts,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RemoteBody {
    pub text: String,
    /// Untrusted. The core keeps it as it came, and passes on what body/mod.rs makes of it.
    pub html: Option<String>,
    pub attachments: Vec<RemoteAttachment>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RemoteAttachment {
    pub name: String,
    pub mime: String,
    pub size: u64,
    pub inline: bool,
}

/// Why a call could not reach or use the provider. The core retries the first three later.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AdapterFailure {
    Offline,
    NeedsSignIn,
    ProviderError,
    /// From `snapshot` only: the provider no longer accepts this page token. See rule 8.
    PageExpired,
}

/// The result of every adapter call: the value, or the reason the provider was not reached.
pub type Outcome<T> = Result<T, AdapterFailure>;

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct SnapshotPage {
    /// The full list of mailboxes, on every page.
    pub mailboxes: Vec<RemoteMailbox>,
    pub messages: Vec<RemoteMessage>,
    pub next: Option<PageToken>,
    /// Set on the last page only. See rule 2.
    pub cursor: Option<Cursor>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct ChangeSet {
    /// Messages the core may not have yet, with all their facts.
    pub added: Vec<RemoteMessage>,
    /// New state for messages the core already has.
    pub updated: Vec<RemoteState>,
    pub removed: Vec<MessageRef>,
    /// The full list of mailboxes when the list changed, else None.
    pub mailboxes: Option<Vec<RemoteMailbox>>,
    pub cursor: Cursor,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ChangesResult {
    Changes(ChangeSet),
    /// The provider no longer remembers this cursor. The core runs `snapshot` again.
    CursorExpired,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum BodyResult {
    Body { body: RemoteBody },
    Gone,
}

/// What `attachment` found.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AttachmentResult {
    /// The attachment's content, decoded from its transfer encoding.
    Bytes(Vec<u8>),
    /// The message is gone, or its body lists no attachment at that place.
    Gone,
}

/// One change to push. Values are absolute: "set unread to false", never "toggle".
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum Mutation {
    Flags {
        refs: Vec<MessageRef>,
        #[serde(skip_serializing_if = "Option::is_none")]
        unread: Option<bool>,
        #[serde(skip_serializing_if = "Option::is_none")]
        flagged: Option<bool>,
    },
    /// With `multiple_mailboxes` false, the core sends exactly one add and one remove: a move.
    Mailboxes {
        refs: Vec<MessageRef>,
        add: Vec<MailboxRef>,
        remove: Vec<MailboxRef>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ApplyResult {
    /// `moved` lists every ref the provider replaced. See rule 4.
    Applied { moved: Vec<Moved> },
    Refused {
        reason: ProviderRefusal,
        /// True when part of the call took effect before the refusal. See rule 11.
        #[serde(default)]
        landed: bool,
    },
    /// The provider may have acted on it, all of it or part, without saying so. See rule 11.
    /// `failure` is how the account's health reads meanwhile.
    Unconfirmed { failure: AdapterFailure },
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct Moved {
    pub from: MessageRef,
    pub to: MessageRef,
}

/// Why a provider turned down a mutation or a send. Every Refusal except `invalid`, which only the core decides.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderRefusal {
    NotPermitted,
    NotSupported,
    UnknownTarget,
    /// A mailbox the mutation names does not exist. See rule 5.
    UnknownMailbox,
    Conflict,
    RefusedByProvider,
}

impl From<ProviderRefusal> for Refusal {
    fn from(reason: ProviderRefusal) -> Self {
        match reason {
            ProviderRefusal::NotPermitted => Refusal::NotPermitted,
            ProviderRefusal::NotSupported => Refusal::NotSupported,
            ProviderRefusal::UnknownTarget | ProviderRefusal::UnknownMailbox => Refusal::UnknownTarget,
            ProviderRefusal::Conflict => Refusal::Conflict,
            ProviderRefusal::RefusedByProvider => Refusal::RefusedByProvider,
        }
    }
}

/// One message for the provider to deliver. The core writes it whole (see mime.rs), so
/// the adapter only hands it over.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outgoing {
    /// The RFC 5322 message every recipient gets, with CRLF line ends and no Bcc header.
    pub raw: String,
    /// Addresses that get the message without being named in it.
    pub bcc: Vec<String>,
    /// Its Message-ID header, without angle brackets.
    pub message_id: String,
    /// The message it answers, for a provider that keeps threads of its own.
    pub reply_to: Option<MessageRef>,
}

impl Outgoing {
    /// `raw` with a Bcc header naming `bcc`, for a provider that reads the recipients from the
    /// headers and leaves Bcc out of what it delivers. The same as `raw` when `bcc` is empty.
    pub fn raw_with_bcc(&self) -> String {
        crate::mime::with_bcc(&self.raw, &self.bcc)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum SendResult {
    /// The provider holds its copy under `ref`. See rule 10.
    Sent {
        r#ref: MessageRef,
    },
    Refused {
        reason: ProviderRefusal,
    },
    /// The call may have reached the provider, but no answer came back. See rule 10.
    Unconfirmed,
}

/// What `find` found: the ref of the message with that Message-ID, or None.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct Found {
    pub r#ref: Option<MessageRef>,
}

/// One signed-in mailbox at one provider.
pub trait Adapter {
    fn capabilities(&self) -> AdapterCapabilities;
    /// Lists the whole mailbox in pages, newest first (rule 9). Pass None for the first page.
    fn snapshot(&self, page: Option<PageToken>) -> LocalFuture<'_, Outcome<SnapshotPage>>;
    /// Everything that changed since `cursor`, across all mailboxes.
    fn changes(&self, cursor: Cursor) -> LocalFuture<'_, Outcome<ChangesResult>>;
    /// The body of one message, fetched when someone opens it.
    fn body(&self, r#ref: MessageRef) -> LocalFuture<'_, Outcome<BodyResult>>;
    /// The content of one attachment: the one at `index` in the list `body` gives for the
    /// message. The core asks it when it sends a forward of the message (see outbox.rs), and
    /// when a UI asks for the file to open or save it (attachments.rs).
    fn attachment(&self, r#ref: MessageRef, index: usize) -> LocalFuture<'_, Outcome<AttachmentResult>>;
    /// Pushes one change. The core calls this one at a time, in the order the user acted.
    fn apply(&self, mutation: Mutation) -> LocalFuture<'_, Outcome<ApplyResult>>;
    /// Delivers one message (rule 10). The core calls it in the account's order, like `apply`.
    fn send(&self, message: Outgoing) -> LocalFuture<'_, Outcome<SendResult>>;
    /// The message the provider holds with this Message-ID (without angle brackets), if any.
    /// The core asks it when a `send` may have reached the provider without saying so.
    fn find(&self, message_id: String) -> LocalFuture<'_, Outcome<Found>>;
    /// Ends every wait the adapter adds between tries of a call, such as a rate-limit backoff,
    /// now and from now on. A call that was waiting answers `offline`. Calls in flight still
    /// finish and later calls still reach the provider, so a closing core's work ends soon.
    fn stop_waiting(&self);
    /// Stops waiting as `stop_waiting` does and releases sockets and timers. A call still in
    /// flight may finish or answer `offline`. The adapter is not used again.
    fn close(&self) -> LocalFuture<'_, ()>;
}

/// Why a sign-in attempt ended without an account.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SignInFailure {
    Cancelled,
    Denied,
    TimedOut,
    WrongPassword,
    Offline,
}

impl From<SignInFailure> for SignInError {
    fn from(failure: SignInFailure) -> Self {
        match failure {
            SignInFailure::Cancelled => SignInError::Cancelled,
            SignInFailure::Denied => SignInError::Denied,
            SignInFailure::TimedOut => SignInError::TimedOut,
            SignInFailure::WrongPassword => SignInError::WrongPassword,
            SignInFailure::Offline => SignInError::Offline,
        }
    }
}

pub struct Connection {
    pub address: String,
    /// Shown next to the account. The only provider name the UI ever sees.
    pub provider_label: String,
    pub adapter: Rc<dyn Adapter>,
    /// Whatever the adapter needs to reconnect after a restart, tokens included. The
    /// core keeps it in the secret store the host gives it (see secrets.rs), never in
    /// its own store, and hands it to `resume`.
    pub session: String,
}

pub struct SignInInput {
    pub password: Option<PasswordInput>,
    /// The adapter calls this with the page the user must visit.
    pub open_url: Box<dyn Fn(String)>,
    /// Cancelled when the user cancels or starts another attempt. The adapter then answers `cancelled`.
    pub signal: CancellationToken,
}

/// How a factory appears in the sign-in options.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FactoryOption {
    pub id: String,
    pub label: String,
    pub method: SignInMethod,
}

/// One way to add an account. The core lists every factory as a sign-in option.
pub trait AdapterFactory {
    fn option(&self) -> &FactoryOption;
    /// Runs one sign-in attempt to its end. Always finishes with an answer.
    fn connect(&self, input: SignInInput) -> LocalFuture<'_, Result<Connection, SignInFailure>>;
    /// Rebuilds the adapter for an account that signed in before.
    fn resume(&self, session: &str) -> Rc<dyn Adapter>;
}
