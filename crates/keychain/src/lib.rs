//! The system keychain as the core's secret store, for the desktop and mobile hosts
//! to pass as `CoreOptions::secrets`. It goes through the keyring crate: Keychain
//! Services on macOS, Credential Manager on Windows, and the Secret Service (GNOME
//! Keyring, KWallet) on Linux. iOS and Android have no backend here yet, so every
//! call fails there and each sign-in answers `keychain`.
//!
//! Each session is one entry under the service "letterbox", named by its account id.
//! A locked keyring, or a Linux desktop with no Secret Service running, shows up as
//! an error from a call, never at build time. accounts.rs in the core says what a
//! failed call does to a sign-in or a sign-out.

use keyring::{Entry, Error};
use letterbox_core::secrets::{Secrets, SecretsError};
use letterbox_protocol::AccountId;

/// The service name every entry is filed under. Keychain tools list the entries by it.
const SERVICE: &str = "letterbox";

/// The keychain of the user the host runs as.
pub struct SystemKeychain;

fn entry(account: &AccountId) -> Result<Entry, SecretsError> {
    Entry::new(SERVICE, account.as_str()).map_err(|error| SecretsError(error.to_string()))
}

impl Secrets for SystemKeychain {
    fn read(&self, account: &AccountId) -> Result<Option<String>, SecretsError> {
        match entry(account)?.get_password() {
            Ok(session) => Ok(Some(session)),
            Err(Error::NoEntry) => Ok(None),
            Err(error) => Err(SecretsError(error.to_string())),
        }
    }

    fn write(&self, account: &AccountId, session: &str) -> Result<(), SecretsError> {
        entry(account)?
            .set_password(session)
            .map_err(|error| SecretsError(error.to_string()))
    }

    fn delete(&self, account: &AccountId) -> Result<(), SecretsError> {
        match entry(account)?.delete_credential() {
            Ok(()) | Err(Error::NoEntry) => Ok(()),
            Err(error) => Err(SecretsError(error.to_string())),
        }
    }
}
