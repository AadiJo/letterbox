//! The program around the core. It owns the one transport every UI uses: one JSON
//! message per line in, one per line out. `core-sim` (crates/sim-client) and the app's
//! `letterbox-core` (src/main.rs) both run the core through `run_stdio`. They differ
//! only in the `Parts` they pass: a fixed clock and the sim provider for the scenarios,
//! or `app_parts` for a person.
//!
//! A host with another transport, such as a phone app over FFI, calls `run` with its own
//! input and output.

use std::cell::RefCell;
use std::io::Write;
use std::path::PathBuf;
use std::process::ExitCode;
use std::rc::Rc;
use std::time::Duration;

use letterbox_core::adapter::AdapterFactory;
use letterbox_core::clock::{Environment, SystemEnvironment};
use letterbox_core::secrets::Secrets;
use letterbox_core::{Core, CoreOptions, StoreError};
use letterbox_gmail::{GmailConfig, gmail_factory};
use letterbox_keychain::SystemKeychain;
use serde_json::Value;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, BufReader};
use tokio::task::LocalSet;

/// Everything the core gets from its host except the transport, which `run` adds.
pub struct Parts {
    /// The folder that holds the store.
    pub data_path: PathBuf,
    pub env: Box<dyn Environment>,
    /// Holds each signed-in account's session.
    pub secrets: Box<dyn Secrets>,
    /// One per way to add an account.
    pub factories: Vec<Rc<dyn AdapterFactory>>,
    /// How long a send waits before it goes out, so the user can undo it.
    pub undo_window: Duration,
    /// How long the core looks for a send whose answer was lost before it says so.
    pub confirm_window: Duration,
}

/// The undo window a person gets: long enough to catch a mistake, short enough not to wonder.
pub const UNDO_WINDOW: Duration = Duration::from_secs(10);

/// How long a person's core looks for a send whose answer was lost. A provider's search
/// can lag a send by seconds, so a couple of minutes covers it.
pub const CONFIRM_WINDOW: Duration = Duration::from_secs(120);

/// The owner's Google OAuth client of type "Desktop app". Gmail sign-ins go through it.
/// It never lives in the repo: the app reads it from a file at startup.
pub struct GmailClient {
    pub id: String,
    pub secret: Option<String>,
}

/// The parts a real app runs the core with: the wall clock, the system keychain, and
/// Gmail at Google's real endpoints.
pub fn app_parts(data_path: PathBuf, gmail: GmailClient) -> Parts {
    Parts {
        data_path,
        env: Box::new(SystemEnvironment),
        secrets: Box::new(SystemKeychain),
        factories: vec![gmail_factory(GmailConfig::google(gmail.id, gmail.secret))],
        undo_window: UNDO_WINDOW,
        confirm_window: CONFIRM_WINDOW,
    }
}

/// Runs a core for one client until `input` ends. Each line of `input` is one message
/// for the core, and each message from the core goes to `output` as one line. Once
/// `input` ends, `input_closed` runs, then the core finishes its work in flight.
///
/// Call it inside a tokio LocalSet, on a runtime with io and time on: the Gmail
/// adapter's HTTP client needs the timer (see `GmailFactory::new`).
pub async fn run(
    parts: Parts,
    input: impl AsyncBufRead + Unpin,
    output: impl Write + 'static,
    input_closed: impl FnOnce(),
) -> Result<(), StoreError> {
    let output = RefCell::new(output);
    let core = Core::new(CoreOptions {
        data_path: parts.data_path,
        env: parts.env,
        secrets: parts.secrets,
        factories: parts.factories,
        undo_window: parts.undo_window,
        confirm_window: parts.confirm_window,
        send: Box::new(move |message| {
            let mut line = serde_json::to_vec(&message).expect("core messages are plain data");
            line.push(b'\n');
            let mut output = output.borrow_mut();
            output
                .write_all(&line)
                .and_then(|()| output.flush())
                .expect("the client's output stays open while the core runs");
        }),
    })?;

    let mut lines = input.lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if line.trim().is_empty() {
            continue;
        }
        // Text that is not JSON stays as a string. The core answers it with a protocol-error.
        let value = serde_json::from_str(&line).unwrap_or(Value::String(line));
        core.receive(value);
        // Let the work this message started take its first steps before the next message
        // is read, so work runs in the order the client asked for it.
        tokio::task::yield_now().await;
    }
    input_closed();
    core.close().await;
    Ok(())
}

/// Runs a core over stdin and stdout until stdin closes, and gives the program's exit
/// code. `program` names the program in what it writes to stderr. Once stdin closes it
/// writes `<program>: input closed, finishing the work in flight`, which the harness
/// waits for (packages/harness/src/client.ts).
#[expect(
    clippy::disallowed_methods,
    clippy::disallowed_macros,
    reason = "this is the transport: it owns stdout for the protocol and stderr for the log"
)]
pub fn run_stdio(program: &str, parts: Parts) -> ExitCode {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_io()
        .enable_time()
        .build()
        .expect("a single-thread runtime starts");
    let input = BufReader::new(tokio::io::stdin());
    let input_closed = || eprintln!("{program}: input closed, finishing the work in flight");
    let ran = LocalSet::new().block_on(&runtime, run(parts, input, std::io::stdout(), input_closed));
    match ran {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{program}: {error}");
            ExitCode::FAILURE
        }
    }
}
