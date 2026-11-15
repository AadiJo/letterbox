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
//!      when none of them exist.
//!   6. `apply` sets values, so applying the same mutation twice is harmless
//!      wherever the provider keeps refs stable.
//!   7. No method reads or writes anything outside the provider. Adapters keep
//!      their resume point in the cursor and their login in the session string.
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
    /// False for read-only access. The core then never calls `apply`.
    pub modify: bool,
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
    /// Untrusted. The core passes it on unchanged and the UI sandboxes it.
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

/// Why a call could not reach or use the provider. The core retries all three later.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AdapterFailure {
    Offline,
    NeedsSignIn,
    ProviderError,
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
    Applied {
        moved: Vec<Moved>,
    },
    Refused {
        reason: ProviderRefusal,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct Moved {
    pub from: MessageRef,
    pub to: MessageRef,
}

/// Why a provider turned down a mutation. Every Refusal except `invalid`, which only the core decides.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderRefusal {
    NotPermitted,
    NotSupported,
    UnknownTarget,
    Conflict,
    RefusedByProvider,
}

impl From<ProviderRefusal> for Refusal {
    fn from(reason: ProviderRefusal) -> Self {
        match reason {
            ProviderRefusal::NotPermitted => Refusal::NotPermitted,
            ProviderRefusal::NotSupported => Refusal::NotSupported,
            ProviderRefusal::UnknownTarget => Refusal::UnknownTarget,
            ProviderRefusal::Conflict => Refusal::Conflict,
            ProviderRefusal::RefusedByProvider => Refusal::RefusedByProvider,
        }
    }
}

/// One signed-in mailbox at one provider.
pub trait Adapter {
    fn capabilities(&self) -> AdapterCapabilities;
    /// Lists the whole mailbox in pages. Pass None for the first page.
    fn snapshot(&self, page: Option<PageToken>) -> LocalFuture<'_, Outcome<SnapshotPage>>;
    /// Everything that changed since `cursor`, across all mailboxes.
    fn changes(&self, cursor: Cursor) -> LocalFuture<'_, Outcome<ChangesResult>>;
    /// The body of one message, fetched when someone opens it.
    fn body(&self, r#ref: MessageRef) -> LocalFuture<'_, Outcome<BodyResult>>;
    /// Pushes one change. The core calls this one at a time, in the order the user acted.
    fn apply(&self, mutation: Mutation) -> LocalFuture<'_, Outcome<ApplyResult>>;
    /// Releases sockets and timers. The adapter is not used again.
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
    /// Whatever the adapter needs to reconnect after a restart. The core stores it
    /// and hands it to `resume`. Real adapters put tokens here, so the core must
    /// move this into the system keychain before any of them ships.
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
