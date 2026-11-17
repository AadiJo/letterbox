//! The protocol's ids: opaque strings, branded in TypeScript, and who may make each one.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Declares opaque string ids. In TypeScript each one is a branded string, so a plain
/// string cannot be passed where an id belongs.
macro_rules! ids {
    ($($(#[$doc:meta])* $name:ident = $brand:literal),* $(,)?) => {$(
        $(#[$doc])*
        #[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, TS)]
        #[serde(transparent)]
        #[ts(type = $brand)]
        pub struct $name(String);

        impl $name {
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl AsRef<str> for $name {
            fn as_ref(&self) -> &str {
                &self.0
            }
        }

        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(&self.0)
            }
        }
    )*};
}

ids!(
    AccountId = "Id<'Account'>",
    MailboxId = "Id<'Mailbox'>",
    ThreadId = "Id<'Thread'>",
    MessageId = "Id<'Message'>",
    BlobId = "Id<'Blob'>",
    SignInOptionId = "Id<'SignInOption'>",
    /// One per subscription.
    SubscriptionId = "Id<'Subscription'>",
    /// One per command.
    ChangeId = "Id<'Change'>",
    /// One per request.
    RequestId = "Id<'Request'>",
);

/// Ids only the core makes. A client uses the ids it was sent and never makes one.
/// clippy.toml bans `minted` outside crates/core, so a UI crate cannot call it.
macro_rules! minted_by_core {
    ($($name:ident),* $(,)?) => {$(
        impl $name {
            pub fn minted(value: impl Into<String>) -> Self {
                Self(value.into())
            }
        }
    )*};
}

minted_by_core!(AccountId, MailboxId, ThreadId, MessageId, BlobId, SignInOptionId);

/// Ids a client makes, one per subscription, command or request, so it can match the answers.
macro_rules! minted_by_client {
    ($($name:ident),* $(,)?) => {$(
        impl $name {
            pub fn new(value: impl Into<String>) -> Self {
                Self(value.into())
            }
        }
    )*};
}

minted_by_client!(SubscriptionId, ChangeId, RequestId);
