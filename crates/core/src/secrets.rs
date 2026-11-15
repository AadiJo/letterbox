//! Where the core keeps each account's session string. A session holds the
//! provider's login, often a token, so it never goes in the store: the host
//! passes in a secret store through `CoreOptions`, the way it passes the clock.
//! An app gives it the system keychain (crates/keychain). core-sim gives it a
//! file (crates/sim-client).
//!
//! The store says which accounts are signed in. This says only what their
//! sessions are, so a secret left behind by a crash or a failed delete never
//! signs an account back in. accounts.rs orders the writes across the two.

use std::fmt;

use letterbox_protocol::AccountId;

/// One session string per account. Calls block until the store answers, and run on the core's thread.
pub trait Secrets {
    /// The session saved for `account`, or None when there is none.
    fn read(&self, account: &AccountId) -> Result<Option<String>, SecretsError>;
    /// Saves `session` for `account`, in place of any session saved before.
    fn write(&self, account: &AccountId, session: &str) -> Result<(), SecretsError>;
    /// Forgets the session of `account`. Forgetting one that is not there succeeds.
    fn delete(&self, account: &AccountId) -> Result<(), SecretsError>;
}

/// The secret store could not answer, for example a locked keychain or none at all.
/// The text is for a person reading a log, and never reaches a client.
#[derive(Debug)]
pub struct SecretsError(pub String);

impl fmt::Display for SecretsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "the secret store failed: {}", self.0)
    }
}

impl std::error::Error for SecretsError {}
