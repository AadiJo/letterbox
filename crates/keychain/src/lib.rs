//! The system keychain as the core's secret store, for the desktop and mobile hosts
//! to pass as `CoreOptions::secrets`. It goes through the keyring crate: Keychain
//! Services on macOS, Credential Manager on Windows, and the Secret Service (GNOME
//! Keyring, KWallet) on Linux. iOS and Android have no backend here yet, so every
//! call fails there and each sign-in answers `keychain`.
//!
//! Each session is one entry under the service "letterbox", named `<store id>/<account id>`.
//! Two stores under one OS user, such as the dev host's and a second checkout's, each count
//! their accounts from `account_1`, so the account id alone would let one store resume with
//! the other's session. The store id is 32 random hex digits, made at the store's first
//! keychain call and kept in the file `keychain-id` beside the store, in its data folder.
//! An entry from before store ids, named by the account id alone, is moved under the store's
//! name the first time that store reads it. Which store reads it first is the one that gets it.
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

use std::cell::OnceCell;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use keyring::{Entry, Error};
use letterbox_core::secrets::{Secrets, SecretsError};
use letterbox_protocol::AccountId;

/// The service name every entry is filed under. Keychain tools list the entries by it.
const SERVICE: &str = "letterbox";

/// The file in the store's data folder that holds the store id.
pub const STORE_ID_FILE: &str = "keychain-id";

/// The keychain of the user the host runs as, for the store in one data folder.
pub struct SystemKeychain {
    folder: PathBuf,
    /// The store id, once read or made.
    store_id: OnceCell<String>,
}

impl SystemKeychain {
    /// The keychain for the store at `data_path`, the folder `CoreOptions::data_path` names.
    /// The store id is read, or made, at the first call, so a failure shows up as that call's error.
    pub fn for_store(data_path: &Path) -> Self {
        SystemKeychain {
            folder: data_path.to_path_buf(),
            store_id: OnceCell::new(),
        }
    }

    fn store_id(&self) -> Result<&str, SecretsError> {
        if let Some(id) = self.store_id.get() {
            return Ok(id);
        }
        let id = read_or_make_store_id(&self.folder)?;
        Ok(self.store_id.get_or_init(|| id))
    }

    /// This store's entry for `account`.
    fn entry(&self, account: &AccountId) -> Result<Entry, SecretsError> {
        let name = format!("{}/{}", self.store_id()?, account.as_str());
        Entry::new(SERVICE, &name).map_err(failed)
    }
}

/// Reads the store id from the data folder, or makes one there. One core at a time holds a
/// store, so no two calls race for the file. It is written beside its place and renamed into
/// it, so a crash leaves no half-written id.
fn read_or_make_store_id(folder: &Path) -> Result<String, SecretsError> {
    let path = folder.join(STORE_ID_FILE);
    let unreadable = |error: std::io::Error| SecretsError(format!("{}: {error}", path.display()));
    match std::fs::read_to_string(&path) {
        Ok(text) => {
            let id = text.trim();
            if id.len() == 32 && id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                Ok(id.to_owned())
            } else {
                Err(SecretsError(format!("{} does not hold a store id", path.display())))
            }
        }
        Err(error) if error.kind() == ErrorKind::NotFound => {
            let mut bytes = [0; 16];
            getrandom::fill(&mut bytes).map_err(|error| SecretsError(error.to_string()))?;
            let id: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
            let next = folder.join(format!("{STORE_ID_FILE}.next"));
            std::fs::create_dir_all(folder)
                .and_then(|()| std::fs::write(&next, &id))
                .and_then(|()| std::fs::rename(&next, &path))
                .map_err(unreadable)?;
            Ok(id)
        }
        Err(error) => Err(unreadable(error)),
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
        let entry = self.entry(account)?;
        if let Some(session) = password(&entry)? {
            return Ok(Some(session));
        }
        // An entry from before store ids, named by the account id alone: move it under this store's name.
        let old = Entry::new(SERVICE, account.as_str()).map_err(failed)?;
        let Some(session) = password(&old)? else {
            return Ok(None);
        };
        entry.set_password(&session).map_err(failed)?;
        forget(&old)?;
        Ok(Some(session))
    }

    fn write(&self, account: &AccountId, session: &str) -> Result<(), SecretsError> {
        self.entry(account)?.set_password(session).map_err(failed)
    }

    fn delete(&self, account: &AccountId) -> Result<(), SecretsError> {
        forget(&self.entry(account)?)
    }
}
