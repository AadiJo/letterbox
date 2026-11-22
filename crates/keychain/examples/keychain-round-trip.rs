//! A round trip through the system keychain with `SystemKeychain`, the store the app's core
//! uses, under its real service name "letterbox". CI runs it on Windows (Credential Manager)
//! and macOS (Keychain Services), each time with an account name of its own:
//!
//!   cargo run -p letterbox-keychain --example keychain-round-trip -- <account>
//!   cargo run -p letterbox-keychain --example keychain-round-trip -- <account> --locked <keychain>
//!
//! The first form uses three throwaway stores, each a data folder in the temp folder whose
//! store id comes from `letterbox_core::store_id`, as the app host's does. Each new process
//! opens the store again, so it reads the id the store saved. It checks in order:
//!   - store A: a missing entry reads None, and deleting it is fine; a written session reads
//!     back in a new process, as after a restart;
//!   - store B, with the same account id: it reads None, then its own session, while A still
//!     reads A's, each in a new process. Deleting A's leaves B's;
//!   - store C: an entry from before store ids, named by the account id alone, is not read,
//!     and stays as it was. Then the check removes the entry it planted.
//!
//! `--locked` is for macOS, where CI has made the throwaway keychain at `<keychain>` the
//! default. It writes a session, locks that keychain (`security lock-keychain <keychain>`),
//! and stops Keychain Services from asking the user to unlock it, which is what a person
//! pressing Cancel comes to. Then a read and a write must each return an error, never panic
//! or read None: the core answers that write's sign-in with `keychain`, and that read at
//! start shows the account needs a sign-in.
//!
//! It writes to the keychain of whoever runs it, so it runs only on a CI runner
//! (GITHUB_ACTIONS=true) and only for an account named `letterbox-ci-...`. Each step prints
//! one line, and the exit code is 0 only if every step held.

#![expect(
    clippy::disallowed_macros,
    reason = "a check program reports each step on stdout and stderr. No protocol runs here"
)]

use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};

use letterbox_core::secrets::{Secrets, SecretsError};
use letterbox_keychain::SystemKeychain;
use letterbox_protocol::AccountId;

/// Every account this program touches starts with this, so it never reads or writes a real one.
const PREFIX: &str = "letterbox-ci-";

/// The service `SystemKeychain` files entries under, for planting an entry from before store ids.
const SERVICE: &str = "letterbox";

/// Shaped like a Gmail session (crates/gmail/src/factory.rs), with a refresh token of Google's
/// usual length. Windows keeps at most 2560 bytes of UTF-16, 1280 characters, per entry.
const FIRST: &str = r#"{"address":"ci@example.invalid","refresh_token":"1//0gCI-first-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","modify":true}"#;
const SECOND: &str = r#"{"address":"ci@example.invalid","refresh_token":"1//0gCI-second-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB","modify":false}"#;

/// What one step saw, as one line.
type Step = Result<String, String>;

enum Mode {
    RoundTrip,
    Locked(PathBuf),
    /// The child half of a round trip: prints what a fresh process reads in one store.
    Read(PathBuf),
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (account, mode) = match args.as_slice() {
        [account] => (account, Mode::RoundTrip),
        [account, flag, keychain] if flag == "--locked" => (account, Mode::Locked(PathBuf::from(keychain))),
        [flag, store, account] if flag == "--read" => (account, Mode::Read(PathBuf::from(store))),
        _ => return refuse("usage: keychain-round-trip <account> [--locked <keychain>]"),
    };
    if std::env::var("GITHUB_ACTIONS").as_deref() != Ok("true") {
        return refuse("this writes to the system keychain, so it runs only on a CI runner (GITHUB_ACTIONS=true)");
    }
    if !account.starts_with(PREFIX) {
        return refuse(&format!(
            "the account must start with {PREFIX}, so no real entry is touched"
        ));
    }
    #[expect(
        clippy::disallowed_methods,
        reason = "a check program names its own throwaway account"
    )]
    let account = AccountId::minted(account.clone());
    let stores = std::env::temp_dir().join(account.as_str());
    match mode {
        Mode::Read(store) => match here(&store, &account) {
            Ok(session) => {
                println!("{}", session.as_deref().unwrap_or("<none>"));
                ExitCode::SUCCESS
            }
            Err(error) => refuse(&format!("read failed: {error}")),
        },
        Mode::RoundTrip => {
            let _ = std::fs::remove_dir_all(&stores);
            let code = report(&round_trip(&account, &stores));
            let _ = std::fs::remove_dir_all(&stores);
            code
        }
        Mode::Locked(keychain) => report(&locked(&account, &stores.join("locked"), &keychain)),
    }
}

fn refuse(why: &str) -> ExitCode {
    eprintln!("keychain-round-trip: {why}");
    ExitCode::from(2)
}

/// Prints each step and gives the exit code: 0 if every step held.
fn report(steps: &[(&str, Step)]) -> ExitCode {
    let mut failed = 0;
    for (what, step) in steps {
        match step {
            Ok(saw) => println!("ok   {what}: {saw}"),
            Err(saw) => {
                failed += 1;
                println!("FAIL {what}: {saw}");
            }
        }
    }
    println!("{} of {} keychain steps held", steps.len() - failed, steps.len());
    if failed == 0 {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}

/// Holds when `read` gives `expected`, `None` meaning no entry.
fn reads(read: Result<Option<String>, String>, expected: Option<&str>) -> Step {
    match read {
        Ok(found) if found.as_deref() == expected => Ok(shown(found.as_deref())),
        Ok(found) => Err(format!(
            "read {}, expected {}",
            shown(found.as_deref()),
            shown(expected)
        )),
        Err(error) => Err(format!("failed: {error}")),
    }
}

fn shown(session: Option<&str>) -> String {
    match session {
        None => "no entry".to_owned(),
        Some(FIRST) => "the first session".to_owned(),
        Some(SECOND) => "the second session".to_owned(),
        Some(other) => format!("another session of {} characters", other.len()),
    }
}

fn done(result: Result<(), SecretsError>) -> Step {
    result
        .map(|()| "done".to_owned())
        .map_err(|error| format!("failed: {}", error.0))
}

/// The keychain of the store in the data folder `store`, under the id that store holds.
fn keychain(store: &Path) -> Result<SystemKeychain, String> {
    letterbox_core::store_id(store)
        .map(SystemKeychain::for_store)
        .map_err(|error| error.to_string())
}

/// Reads the entry of `store` in this process.
fn here(store: &Path, account: &AccountId) -> Result<Option<String>, String> {
    keychain(store)?.read(account).map_err(|error| error.0)
}

/// Reads the entry of `store` in a new process of this program, as the app's core does after a restart.
fn in_new_process(store: &Path, account: &AccountId) -> Result<Option<String>, String> {
    let program = std::env::current_exe().map_err(|error| error.to_string())?;
    let output = Command::new(program)
        .arg("--read")
        .arg(store)
        .arg(account.as_str())
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_owned());
    }
    let text = String::from_utf8_lossy(&output.stdout).trim_end().to_owned();
    Ok((text != "<none>").then_some(text))
}

/// The entry named by the account id alone, as `SystemKeychain` filed sessions before store ids.
fn old_entry(account: &AccountId) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, account.as_str()).map_err(|error| error.to_string())
}

/// Runs the steps in order. Each one runs only after the one before it has.
fn round_trip(account: &AccountId, stores: &Path) -> Vec<(&'static str, Step)> {
    let (a, b, c) = (stores.join("a"), stores.join("b"), stores.join("c"));
    let mut steps = Vec::new();
    let (store_a, store_b) = match (keychain(&a), keychain(&b)) {
        (Ok(store_a), Ok(store_b)) => (store_a, store_b),
        (Err(error), _) | (_, Err(error)) => {
            steps.push(("open stores A and B", Err(error)));
            return steps;
        }
    };
    let mut step = |what: &'static str, saw: Step| steps.push((what, saw));
    step("A: a missing entry reads None", reads(here(&a, account), None));
    step("A: deleting a missing entry is fine", done(store_a.delete(account)));
    step("A: write the first session", done(store_a.write(account, FIRST)));
    step(
        "A: a new process reads it back",
        reads(in_new_process(&a, account), Some(FIRST)),
    );
    step("B, same account id: reads None", reads(here(&b, account), None));
    step("B: write the second session", done(store_b.write(account, SECOND)));
    step(
        "A: a new process still reads A's",
        reads(in_new_process(&a, account), Some(FIRST)),
    );
    step(
        "B: a new process reads B's",
        reads(in_new_process(&b, account), Some(SECOND)),
    );
    step("A: delete it", done(store_a.delete(account)));
    step(
        "A: after the delete it reads None",
        reads(in_new_process(&a, account), None),
    );
    step(
        "B: a new process still reads B's",
        reads(in_new_process(&b, account), Some(SECOND)),
    );
    step("B: delete it", done(store_b.delete(account)));
    let planted = old_entry(account).and_then(|old| old.set_password(FIRST).map_err(|error| error.to_string()));
    step(
        "plant an entry from before store ids",
        planted.map(|()| "done".to_owned()),
    );
    step(
        "C: an entry named by the account id alone is not read",
        reads(here(&c, account), None),
    );
    let old_left = old_entry(account).and_then(|old| match old.get_password() {
        Ok(session) => Ok(Some(session)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(error.to_string()),
    });
    step("C: the old entry stays as it was", reads(old_left, Some(FIRST)));
    let removed = old_entry(account).and_then(|old| old.delete_credential().map_err(|error| error.to_string()));
    step("remove the planted entry", removed.map(|()| "done".to_owned()));
    steps
}

/// Holds when the call failed with an error, which the core turns into `keychain`.
#[cfg(target_os = "macos")]
fn refused<T: std::fmt::Debug>(result: Result<T, SecretsError>) -> Step {
    match result {
        Err(error) => Ok(format!("error: {}", error.0)),
        Ok(value) => Err(format!("expected an error, got Ok({value:?})")),
    }
}

/// A session written, `keychain` locked, then a read and a write that may not ask the user to
/// unlock it. macOS only.
#[cfg(target_os = "macos")]
fn locked(account: &AccountId, store: &Path, keychain: &Path) -> Vec<(&'static str, Step)> {
    let secrets = match keychain(store) {
        Ok(secrets) => secrets,
        Err(error) => return vec![("open the store", Err(error))],
    };
    let mut steps = vec![("write a session", done(secrets.write(account, FIRST)))];
    let lock = Command::new("/usr/bin/security")
        .arg("lock-keychain")
        .arg(keychain)
        .status();
    steps.push((
        "lock the keychain",
        match lock {
            Ok(status) if status.success() => Ok(keychain.display().to_string()),
            Ok(status) => Err(format!("security lock-keychain exited with {status}")),
            Err(error) => Err(error.to_string()),
        },
    ));
    // Without this a locked keychain asks the user to unlock it, and a CI runner has no one to answer.
    let _no_prompts = match security_framework::os::macos::keychain::SecKeychain::disable_user_interaction() {
        Ok(guard) => guard,
        Err(error) => {
            steps.push(("turn off keychain prompts", Err(error.to_string())));
            return steps;
        }
    };
    steps.push((
        "a read from the locked keychain is an error",
        refused(secrets.read(account)),
    ));
    steps.push((
        "a write to the locked keychain is an error",
        refused(secrets.write(account, SECOND)),
    ));
    steps
}

#[cfg(not(target_os = "macos"))]
fn locked(_account: &AccountId, _store: &Path, _keychain: &Path) -> Vec<(&'static str, Step)> {
    vec![(
        "--locked",
        Err("runs on macOS only, where CI can lock the keychain".to_owned()),
    )]
}
