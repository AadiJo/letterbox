//! The core as a process, wired to the sim provider. This is what every scenario
//! talks to: one JSON message per line on stdin, one per line on stdout.
//!
//!   core-sim --data <folder> --sim <socket> [--now <time>]
//!
//! packages/harness builds it and starts one per scenario, or more to test a restart.
//! A real app gets its own entry point with real adapters. Nothing here is test
//! logic inside the core: this file only chooses which factories, clock and secret store it gets.

use std::io::Write;
use std::path::PathBuf;
use std::process::ExitCode;

use letterbox_core::clock::FixedEnvironment;
use letterbox_core::{Core, CoreOptions};
use letterbox_sim_client::{FileKeychain, sim_adapter_factories};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::task::LocalSet;

const USAGE: &str = "usage: core-sim --data <folder> --sim <socket> [--now <time>]";

/// Written to stderr once stdin closes, before the core finishes its work and exits.
const INPUT_CLOSED: &str = "core-sim: input closed, finishing the work in flight";

/// The file in the data folder that stands in for the keychain. The harness reads it by
/// this name (SIM_KEYCHAIN in packages/harness/src/invariants.ts).
const KEYCHAIN_FILE: &str = "sim-keychain.json";

struct Args {
    data: PathBuf,
    sim: PathBuf,
    now: String,
}

fn parse_args() -> Option<Args> {
    let mut data = None;
    let mut sim = None;
    let mut now = "2026-01-01T00:00:00.000Z".to_owned();
    let mut args = std::env::args().skip(1);
    while let Some(flag) = args.next() {
        let value = args.next()?;
        match flag.as_str() {
            "--data" => data = Some(PathBuf::from(value)),
            "--sim" => sim = Some(PathBuf::from(value)),
            "--now" => now = value,
            _ => return None,
        }
    }
    Some(Args {
        data: data?,
        sim: sim?,
        now,
    })
}

#[expect(
    clippy::disallowed_methods,
    clippy::disallowed_macros,
    reason = "this program is the transport: it owns stdout for the protocol and stderr for the log"
)]
fn main() -> ExitCode {
    let Some(args) = parse_args() else {
        eprintln!("{USAGE}");
        return ExitCode::from(2);
    };
    let env = match FixedEnvironment::new(&args.now) {
        Ok(env) => env,
        Err(error) => {
            eprintln!("--now: {error}\n{USAGE}");
            return ExitCode::from(2);
        }
    };
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_io()
        .build()
        .expect("a single-thread runtime starts");

    LocalSet::new().block_on(&runtime, async move {
        let options = CoreOptions {
            secrets: Box::new(FileKeychain::new(args.data.join(KEYCHAIN_FILE))),
            data_path: args.data,
            env: Box::new(env),
            factories: sim_adapter_factories(&args.sim),
            send: Box::new(|message| {
                let mut out = std::io::stdout().lock();
                serde_json::to_writer(&mut out, &message).expect("core messages are plain data");
                out.write_all(b"\n").expect("stdout is open while the core runs");
            }),
        };
        let core = match Core::new(options) {
            Ok(core) => core,
            Err(error) => {
                eprintln!("{error}");
                return ExitCode::FAILURE;
            }
        };

        let mut lines = BufReader::new(tokio::io::stdin()).lines();
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
        // Stdin closed. Finish the work in flight, then stop. The harness waits for this line
        // to know the core has read the end of its input (see packages/harness/src/client.ts).
        eprintln!("{INPUT_CLOSED}");
        core.close().await;
        ExitCode::SUCCESS
    })
}
