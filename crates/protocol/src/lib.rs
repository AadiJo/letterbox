//! The protocol between the core and every UI. Version 0.
//!
//! This crate is the only place the protocol is written by hand. `cargo xtask protocol-ts`
//! writes the TypeScript types from it (packages/protocol/src/generated.ts), and `pnpm
//! check` fails while that copy is stale. The harness also checks every message the core
//! sends against a schema that the TypeScript build holds to those generated types.
//!
//! Client messages only need to be read here, and core messages only written, so
//! each type derives just the direction it travels.
//!
//! Guarantees the core makes. Each one is a conformance test for any core or adapter.
//!   1. Read your writes. An update with rev >= the rev of an accepted change includes that change.
//!   2. Every accepted change gets exactly one `settled`.
//!   3. Changes on one account reach the provider in the order they were accepted. A send
//!      joins that order when its undo window ends.
//!   4. Sending the same ChangeId twice has the same effect as sending it once.
//!   5. A failed change is reverted in the store before `settled` is sent. A failed send
//!      stays in its conversation, marked failed.
//!   6. No provider id, provider name or credential appears in a core-to-UI message.
//!      The only exception is the display label on Account and SignInOption.
//!   7. Every request gets exactly one response. That includes a sign-in that is
//!      cancelled, superseded or timed out.
//!   8. Updates caused by a command or request are sent before its `settled` or
//!      `response`. A client that has the answer has already seen the effects.

mod answer;
mod command;
mod holder;
mod ids;
mod lists;
mod outcome;
mod recipients;
mod send;
mod subscribe;

pub use answer::{Answer, Empty, False, Never, True};
pub use command::{Command, TurnChoice};
pub use holder::ChangeHolder;
pub use ids::{
    AccountId, BlobId, ChangeId, MailboxId, MessageId, RequestId, SenderId, SignInOptionId, SubscriptionId, ThreadId,
};
pub use lists::{SenderDay, SenderPage, SenderSummary, ThreadFilter};
pub use outcome::{ChangeResult, Refusal, UndoConflict, UndoField};
pub use recipients::Recipient;
pub use send::{Delivery, Draft};
use serde::{Deserialize, Deserializer, Serialize};
pub use subscribe::{Query, ThreadPage, Update};
use ts_rs::TS;

pub const PROTOCOL: u32 = 0;

/// Store revision. It rises on every change to the store and never repeats.
pub type Rev = u64;
/// ISO 8601 in UTC, for example "2026-11-14T23:04:01Z".
pub type Time = String;

/// Reads an optional field that may be left out but may not be `null`, as `field?: T` allows in TypeScript.
/// Use with `#[serde(default, deserialize_with = "present")]`.
fn present<'de, D: Deserializer<'de>, T: Deserialize<'de>>(deserializer: D) -> Result<Option<T>, D::Error> {
    T::deserialize(deserializer).map(Some)
}

// ---------------------------------------------------------------- model

#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: AccountId,
    pub address: String,
    /// Display only, for example "Gmail". UI logic reads `can`, never this.
    pub provider_label: String,
    pub can: Capabilities,
    pub status: AccountStatus,
}

/// What this account allows. The UI enables and hides controls from these alone.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    /// False while access is read-only. Every command except set-turn is then rejected.
    pub modify: bool,
    pub send: bool,
    /// True where one message can sit in several mailboxes (labels). False for plain folders.
    pub multiple_mailboxes: bool,
}

/// Sync state of one account. `last_synced_at` lets the UI say honestly how stale a view is.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(tag = "state", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum AccountStatus {
    Syncing {
        done: u64,
        total: Option<u64>,
        last_synced_at: Option<Time>,
    },
    Idle {
        last_synced_at: Time,
    },
    Offline {
        last_synced_at: Option<Time>,
    },
    NeedsSignIn,
    Error {
        reason: AccountErrorReason,
        last_synced_at: Option<Time>,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum AccountErrorReason {
    Provider,
    Storage,
}

/// A folder or a label. A message belongs to a set of these.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Mailbox {
    pub id: MailboxId,
    pub account_id: AccountId,
    pub name: String,
    /// A mailbox with no role is a user folder or label.
    pub role: Option<Role>,
    pub parent_id: Option<MailboxId>,
    pub unread: u64,
    pub total: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum Role {
    Inbox,
    Sent,
    Drafts,
    Archive,
    Trash,
    Spam,
}

#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Person {
    pub name: Option<String>,
    pub address: String,
    pub is_me: bool,
}

/// Who owes the next message in a conversation.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum Turn {
    Mine,
    Theirs,
    #[serde(rename = "none")]
    Nobody,
}

/// Why the core decided that. Shown to the user and saved with every correction.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum TurnReason {
    TheyWroteLast,
    IWroteLast,
    Automated,
    NotAddressedToMe,
    AsksNothing,
    SetByUser,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
pub struct TurnState {
    pub holder: Turn,
    pub reason: TurnReason,
}

/// One row in a list. The core builds threads itself, so every provider gets them.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSummary {
    pub id: ThreadId,
    pub account_id: AccountId,
    pub subject: String,
    pub people: Vec<Person>,
    pub snippet: String,
    pub last_message_at: Time,
    pub message_count: u64,
    pub unread: bool,
    pub flagged: bool,
    pub has_attachments: bool,
    pub mailbox_ids: Vec<MailboxId>,
    pub turn: TurnState,
    /// True while a change to this thread has not settled.
    pub pending: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, TS)]
pub struct ThreadDetail {
    #[serde(flatten)]
    pub summary: ThreadSummary,
    pub messages: Vec<Message>,
}

#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub id: MessageId,
    pub from: Person,
    pub to: Vec<Person>,
    pub cc: Vec<Person>,
    pub sent_at: Time,
    pub unread: bool,
    pub body: Body,
    pub attachments: Vec<Attachment>,
    /// Set only on a message the user sent that the provider does not hold yet, or refused.
    pub delivery: Option<Delivery>,
}

/// Bodies download on demand, so one can be missing while offline.
/// `html` is hostile input. The UI must render it sandboxed, with scripts and
/// network off. The core never fetches remote content named in a message.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(tag = "state", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum Body {
    Ready {
        text: String,
        html: Option<String>,
        has_remote_content: bool,
    },
    Loading,
    Unavailable {
        reason: Unavailable,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum Unavailable {
    Offline,
    TooLarge,
    Gone,
}

#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub blob_id: BlobId,
    pub name: String,
    pub mime: String,
    pub size: u64,
    pub inline: bool,
}

// ---------------------------------------------------------------- request

/// A way to add an account. The UI lists these and never hard-codes a provider.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
pub struct SignInOption {
    pub id: SignInOptionId,
    pub label: String,
    pub method: SignInMethod,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum SignInMethod {
    Oauth,
    Password,
}

/// Every one-shot call. Add a variant here and a matching one to `Response`.
#[derive(Clone, Debug, PartialEq, Deserialize, TS)]
#[serde(tag = "method", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum Request {
    /// Answers once the account exists. For oauth the core sends `open-url` first.
    SignIn {
        option: SignInOptionId,
        #[serde(default, deserialize_with = "present")]
        #[ts(optional)]
        password: Option<PasswordInput>,
    },
    SignOut {
        account_id: AccountId,
        delete_local_mail: bool,
    },
    SyncNow {
        #[serde(default, deserialize_with = "present")]
        #[ts(optional)]
        account_id: Option<AccountId>,
    },
    /// A local URL the core serves for one attachment or inline image.
    Blob { blob_id: BlobId },
}

#[derive(Clone, Debug, PartialEq, Deserialize, TS)]
pub struct PasswordInput {
    pub username: String,
    pub password: String,
    #[serde(default, deserialize_with = "present")]
    #[ts(optional)]
    pub server: Option<String>,
}

/// The answer to one request, by method.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(tag = "method", rename_all = "kebab-case")]
pub enum Response {
    SignIn(Answer<SignedIn, SignInError>),
    SignOut(Answer<Empty, Never>),
    SyncNow(Answer<Empty, SyncNowError>),
    Blob(Answer<BlobUrl, BlobError>),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SignedIn {
    pub account_id: AccountId,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum SignInError {
    Cancelled,
    Denied,
    TimedOut,
    Superseded,
    WrongPassword,
    Offline,
    /// The provider let the user in, but the system keychain would not save the login,
    /// for example because it is locked. No account was added. Unlock it and sign in again.
    Keychain,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum SyncNowError {
    Offline,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
pub struct BlobUrl {
    pub url: String,
    pub mime: String,
    pub size: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum BlobError {
    Offline,
    Gone,
    NotSupported,
}

// ---------------------------------------------------------------- envelope

#[derive(Clone, Debug, PartialEq, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ClientMessage {
    /// `protocol` is any number, so a client on another version gets version-mismatch, not malformed.
    Hello {
        protocol: f64,
    },
    Subscribe {
        sub: SubscriptionId,
        query: Query,
    },
    Unsubscribe {
        sub: SubscriptionId,
    },
    Command {
        change: ChangeId,
        command: Command,
    },
    Request {
        id: RequestId,
        request: Request,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum CoreMessage {
    Welcome {
        protocol: u32,
        rev: Rev,
    },
    Update {
        sub: SubscriptionId,
        rev: Rev,
        #[serde(flatten)]
        update: Update,
    },
    /// The change is in the store and in the durable queue.
    Accepted {
        change: ChangeId,
        rev: Rev,
    },
    /// The change was never applied. `conflict` says why an undo was refused `conflict`,
    /// when one field or mailbox does.
    Rejected {
        change: ChangeId,
        reason: Refusal,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        conflict: Option<UndoConflict>,
    },
    /// The last word on a change. A failed change is already reverted at `rev`.
    Settled {
        change: ChangeId,
        rev: Rev,
        result: ChangeResult,
    },
    Response {
        id: RequestId,
        #[serde(flatten)]
        response: Response,
    },
    /// The UI opens this in the system browser. The token goes to the core, never the UI.
    OpenUrl {
        id: RequestId,
        url: String,
    },
    /// The core could not read a client message, or the versions differ. `detail` is for logs.
    ProtocolError {
        reason: ProtocolErrorReason,
        detail: String,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum ProtocolErrorReason {
    VersionMismatch,
    Malformed,
}
