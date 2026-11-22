//! The system keychain as the core's secret store, for the desktop and mobile hosts
//! to pass as `CoreOptions::secrets`. It goes through the keyring crate: Keychain
//! Services on macOS, Credential Manager on Windows, and the Secret Service (GNOME
//! Keyring, KWallet) on Linux. iOS and Android have no backend here yet, so every
//! call fails there and each sign-in answers `keychain`.
//!
//! Each session is one entry under the service "letterbox", named `<store id>/<account id>`.
//! Two stores under one OS user, such as the dev host's and a second checkout's, each count
//! their accounts from `account_1`, so the account id alone would let one store resume with
//! the other's session. The store id comes from the store itself (`letterbox_core::store_id`).
//! Entries from before store ids, named by the account id alone, are never read: nothing says
//! which store wrote one, so its account signs in once more, and the old entry stays as it was.
//!
//! Where a person finds an entry:
//!   - macOS: Keychain Access, login keychain, a password named "letterbox" whose
//!     account is `<store id>/<account id>`. The first access asks whether letterbox-core may use
//!     it. macOS ties "Always Allow" to the program's signature, and a debug build is
//!     not signed, so it may ask again after each rebuild. Each prompt holds the core
//!     until it is answered, since the core calls the keychain on its one thread.
//!   - Windows: Credential Manager, Windows Credentials, a generic credential named
//!     `<store id>/<account id>.letterbox`. It never asks. An entry holds at most 1280 characters,
//!     and a Gmail session is a tenth of that.
//!   - Linux: the Secret Service, under the attributes service=letterbox and
//!     username=<store id>/<account id>.
//!
//! A locked or denied keychain (Cancel at the macOS prompt), or a Linux desktop with no
//! Secret Service running, shows up as an error from a call, never a panic or a build
//! failure. accounts.rs in the core says what a failed call does to a sign-in or a
//! sign-out. CI runs a real round trip on Windows and macOS, with two stores and an old
//! entry, and a locked keychain on macOS (examples/keychain-round-trip.rs).

use keyring::{Entry, Error};
use letterbox_core::secrets::{Secrets, SecretsError};
use letterbox_protocol::AccountId;

/// The service name every entry is filed under. Keychain tools list the entries by it.
const SERVICE: &str = "letterbox";

/// The keychain of the user the host runs as, for one store.
pub struct SystemKeychain {
    store_id: String,
}

impl SystemKeychain {
    /// The keychain for the store whose id is `store_id`, from `letterbox_core::store_id`.
    pub fn for_store(store_id: String) -> Self {
        SystemKeychain { store_id }
    }

    /// This store's entry for `account`.
    fn entry(&self, account: &AccountId) -> Result<Entry, SecretsError> {
        Entry::new(SERVICE, &format!("{}/{}", self.store_id, account.as_str())).map_err(failed)
    }
}

fn failed(error: Error) -> SecretsError {
    SecretsError(error.to_string())
}

/// The password in `entry`, or None when there is no such entry.
fn password(entry: &Entry) -> Result<Option<String>, SecretsError> {
    match entry.get_password() {
        Ok(session) => Ok(Some(session)),
        Err(Error::NoEntry) => Ok(None),
        Err(error) => Err(failed(error)),
    }
}

/// Deletes `entry`. One that is not there is already deleted.
fn forget(entry: &Entry) -> Result<(), SecretsError> {
    match entry.delete_credential() {
        Ok(()) | Err(Error::NoEntry) => Ok(()),
        Err(error) => Err(failed(error)),
    }
}

impl Secrets for SystemKeychain {
    fn read(&self, account: &AccountId) -> Result<Option<String>, SecretsError> {
        password(&self.entry(account)?)
    }

    fn write(&self, account: &AccountId, session: &str) -> Result<(), SecretsError> {
        self.entry(account)?.set_password(session).map_err(failed)
    }

    fn delete(&self, account: &AccountId) -> Result<(), SecretsError> {
        forget(&self.entry(account)?)
    }
}
