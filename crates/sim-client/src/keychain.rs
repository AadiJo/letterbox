//! A stand-in for the system keychain, for core-sim, the test program, only. It keeps
//! every session as plain JSON in one file, which protects nothing. It exists so the
//! scenarios that restart the core can resume their accounts, and so a scenario can
//! read which accounts still have a session. A real app passes crates/keychain instead.

use std::collections::BTreeMap;
use std::io::ErrorKind;
use std::path::PathBuf;

use letterbox_core::secrets::{Secrets, SecretsError};
use letterbox_protocol::AccountId;

/// Sessions by account id, in the JSON file at `path`. The file appears on the first write.
pub struct FileKeychain {
    path: PathBuf,
}

impl FileKeychain {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    fn entries(&self) -> Result<BTreeMap<String, String>, SecretsError> {
        match std::fs::read(&self.path) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|error| SecretsError(error.to_string())),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(BTreeMap::new()),
            Err(error) => Err(SecretsError(error.to_string())),
        }
    }

    /// Writes a new file beside the old one, then moves it into place, so a crash leaves one whole file.
    fn save(&self, entries: &BTreeMap<String, String>) -> Result<(), SecretsError> {
        let next = self.path.with_extension("next");
        let text = serde_json::to_vec(entries).expect("sessions are plain strings");
        std::fs::write(&next, text)
            .and_then(|()| std::fs::rename(&next, &self.path))
            .map_err(|error| SecretsError(error.to_string()))
    }
}

impl Secrets for FileKeychain {
    fn read(&self, account: &AccountId) -> Result<Option<String>, SecretsError> {
        Ok(self.entries()?.remove(account.as_str()))
    }

    fn write(&self, account: &AccountId, session: &str) -> Result<(), SecretsError> {
        let mut entries = self.entries()?;
        entries.insert(account.as_str().to_owned(), session.to_owned());
        self.save(&entries)
    }

    fn delete(&self, account: &AccountId) -> Result<(), SecretsError> {
        let mut entries = self.entries()?;
        if entries.remove(account.as_str()).is_some() {
            self.save(&entries)?;
        }
        Ok(())
    }
}
