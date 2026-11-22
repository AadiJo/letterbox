//! Adding an account: the ways to sign in, and what a sign-in request takes and answers.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::{AccountId, SignInOptionId, present};

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

#[derive(Clone, Debug, PartialEq, Deserialize, TS)]
pub struct PasswordInput {
    pub username: String,
    pub password: String,
    #[serde(default, deserialize_with = "present")]
    #[ts(optional)]
    pub server: Option<String>,
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
