//! A round trip through the system keychain with `SystemKeychain`, the store the app's core
//! uses, under its real service name "letterbox". CI runs it on Windows (Credential Manager)
//! and macOS (Keychain Services), each time with an account name of its own:
//!
//!   cargo run -p letterbox-keychain --example keychain-round-trip -- <account>
//!   cargo run -p letterbox-keychain --example keychain-round-trip -- <account> --locked
//!
//! The first form checks, in order: a missing entry reads None, deleting it is fine, a written
//! session reads back in a new process (as after a restart), a second write replaces it, and
//! after a delete it reads None again, in this process and a new one.
//!
//! `--locked` is for macOS, where CI has made a throwaway keychain the default. It writes a
//! session, locks that keychain (`security lock-keychain`), and stops Keychain Services from
//! asking the user to unlock it, which is what a person pressing Cancel comes to. Then a read
//! and a write must each return an error, never panic or read None: the core answers that
//! write's sign-in with `keychain`, and that read at start shows the account needs a sign-in.
//!
//! It writes to the keychain of whoever runs it, so it runs only on a CI runner
//! (GITHUB_ACTIONS=true) and only for an account named `letterbox-ci-...`. Each step prints
//! one line, and the exit code is 0 only if every step held.

#![expect(
    clippy::disallowed_macros,
    reason = "a check program reports each step on stdout and stderr. No protocol runs here"
)]

use std::process::{Command, ExitCode};

use letterbox_core::secrets::Secrets;
use letterbox_keychain::SystemKeychain;
use letterbox_protocol::AccountId;

/// Every account this program touches starts with this, so it never reads or writes a real one.
const PREFIX: &str = "letterbox-ci-";

/// Shaped like a Gmail session (crates/gmail/src/factory.rs), with a refresh token of Google's
/// usual length. Windows keeps at most 2560 bytes of UTF-16, 1280 characters, per entry.
const FIRST: &str = r#"{"address":"ci@example.invalid","refresh_token":"1//0gCI-first-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","modify":true}"#;
const SECOND: &str = r#"{"address":"ci@example.invalid","refresh_token":"1//0gCI-second-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB","modify":false}"#;

/// What one step saw, as one line.
type Step = Result<String, String>;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (account, mode) = match args.as_slice() {
        [account] => (account, Mode::RoundTrip),
        [account, flag] if flag == "--locked" => (account, Mode::Locked),
        [flag, account] if flag == "--read" => (account, Mode::Read),
        _ => return refuse("usage: keychain-round-trip <account> [--locked]"),
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
    match mode {
        // The child half of a round trip: print what a fresh process reads, for the parent to compare.
        Mode::Read => match SystemKeychain.read(&account) {
            Ok(Some(session)) => {
                println!("{session}");
                ExitCode::SUCCESS
            }
            Ok(None) => {
                println!("<none>");
                ExitCode::SUCCESS
            }
            Err(error) => refuse(&format!("read failed: {}", error.0)),
        },
        Mode::RoundTrip => report(&round_trip(&account)),
        Mode::Locked => report(&locked(&account)),
    }
}

enum Mode {
    RoundTrip,
    Locked,
    Read,
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
    session.map_or_else(
        || "no entry".to_owned(),
        |session| format!("{} characters", session.len()),
    )
}

/// Reads the entry in a new process of this program, as the app's core does after a restart.
fn read_in_new_process(account: &AccountId) -> Result<Option<String>, String> {
    let program = std::env::current_exe().map_err(|error| error.to_string())?;
    let output = Command::new(program)
        .args(["--read", account.as_str()])
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_owned());
    }
    let text = String::from_utf8_lossy(&output.stdout).trim_end().to_owned();
    Ok((text != "<none>").then_some(text))
}

fn here(account: &AccountId) -> Result<Option<String>, String> {
    SystemKeychain.read(account).map_err(|error| error.0)
}

fn done(result: Result<(), letterbox_core::secrets::SecretsError>) -> Step {
    result
        .map(|()| "done".to_owned())
        .map_err(|error| format!("failed: {}", error.0))
}

fn round_trip(account: &AccountId) -> Vec<(&'static str, Step)> {
    let keychain = SystemKeychain;
    vec![
        ("a missing entry reads None", reads(here(account), None)),
        ("deleting a missing entry is fine", done(keychain.delete(account))),
        ("write a session", done(keychain.write(account, FIRST))),
        (
            "a new process reads it back",
            reads(read_in_new_process(account), Some(FIRST)),
        ),
        ("write a second session over it", done(keychain.write(account, SECOND))),
        ("it reads the second session", reads(here(account), Some(SECOND))),
        ("delete it", done(keychain.delete(account))),
        ("after the delete it reads None", reads(here(account), None)),
        (
            "a new process reads None too",
            reads(read_in_new_process(account), None),
        ),
    ]
}

/// Holds when the call failed with an error, which the core turns into `keychain`.
#[cfg(target_os = "macos")]
fn refused<T: std::fmt::Debug>(result: Result<T, letterbox_core::secrets::SecretsError>) -> Step {
    match result {
        Err(error) => Ok(format!("error: {}", error.0)),
        Ok(value) => Err(format!("expected an error, got Ok({value:?})")),
    }
}

/// A session written, the default keychain locked, then a read and a write that may not ask
/// the user to unlock it. macOS only.
#[cfg(target_os = "macos")]
fn locked(account: &AccountId) -> Vec<(&'static str, Step)> {
    let keychain = SystemKeychain;
    let mut steps = vec![("write a session", done(keychain.write(account, FIRST)))];
    let lock = Command::new("/usr/bin/security").arg("lock-keychain").status();
    steps.push((
        "lock the default keychain",
        match lock {
            Ok(status) if status.success() => Ok("done".to_owned()),
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
        refused(keychain.read(account)),
    ));
    steps.push((
        "a write to the locked keychain is an error",
        refused(keychain.write(account, SECOND)),
    ));
    steps
}

#[cfg(not(target_os = "macos"))]
fn locked(_account: &AccountId) -> Vec<(&'static str, Step)> {
    vec![(
        "--locked",
        Err("runs on macOS only, where CI can lock the keychain".to_owned()),
    )]
}
