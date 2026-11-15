//! The core as a process, wired to the sim provider. This is what every scenario
//! talks to: one JSON message per line on stdin, one per line on stdout.
//!
//!   core-sim --data <folder> [--sim <socket>] [--gmail <url> --gmail-redirects <folder>] [--now <time>]
//!
//! `--sim` lists the two sim provider options. `--gmail` adds the Gmail option, pointed at
//! the fake Gmail server at `<url>` (packages/sim-provider/src/gmail). Its consent URLs must
//! not change between runs, so its random source and loopback port are fixed here, and the
//! browser's redirect arrives on a unix socket in `--gmail-redirects`. At least one is needed.
//!
//! packages/harness builds it and starts one per scenario, or more to test a restart.
//! A real app gets its own entry point with real adapters. Nothing here is test
//! logic inside the core: this file only chooses which factories, clock and secret store it gets.

use std::cell::Cell;
use std::io::Write;
use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr};
use std::path::PathBuf;
use std::process::ExitCode;
use std::rc::Rc;

use letterbox_core::adapter::AdapterFactory;
use letterbox_core::clock::FixedEnvironment;
use letterbox_core::{Core, CoreOptions};
use letterbox_gmail::{GmailConfig, Loopback, gmail_factory};
use letterbox_sim_client::{FileKeychain, sim_adapter_factories};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::task::LocalSet;

const USAGE: &str =
    "usage: core-sim --data <folder> [--sim <socket>] [--gmail <url> --gmail-redirects <folder>] [--now <time>]";

/// Written to stderr once stdin closes, before the core finishes its work and exits.
const INPUT_CLOSED: &str = "core-sim: input closed, finishing the work in flight";

/// The file in the data folder that stands in for the keychain. The harness reads it by
/// this name (SIM_KEYCHAIN in packages/harness/src/invariants.ts).
const KEYCHAIN_FILE: &str = "sim-keychain.json";

/// The name core-sim reaches the fake Gmail server by. It resolves only through `GmailConfig::hosts`.
const FAKE_GMAIL_HOST: &str = "gmail.fake.test";

struct Args {
    data: PathBuf,
    sim: Option<PathBuf>,
    gmail: Option<(String, PathBuf)>,
    now: String,
}

fn parse_args() -> Option<Args> {
    let mut data = None;
    let mut sim = None;
    let mut gmail = None;
    let mut redirects = None;
    let mut now = "2026-01-01T00:00:00.000Z".to_owned();
    let mut args = std::env::args().skip(1);
    while let Some(flag) = args.next() {
        let value = args.next()?;
        match flag.as_str() {
            "--data" => data = Some(PathBuf::from(value)),
            "--sim" => sim = Some(PathBuf::from(value)),
            "--gmail" => gmail = Some(value),
            "--gmail-redirects" => redirects = Some(PathBuf::from(value)),
            "--now" => now = value,
            _ => return None,
        }
    }
    let gmail = match (gmail, redirects) {
        (Some(url), Some(redirects)) => Some((url, redirects)),
        (None, None) => None,
        _ => return None,
    };
    (sim.is_some() || gmail.is_some()).then_some(Args {
        data: data?,
        sim,
        gmail,
        now,
    })
}

/// The Gmail option, pointed at the fake server. Nothing here is a real client: the fake
/// accepts any client id, as long as the code exchange names the one consent did.
fn fake_gmail(url: String, redirects: PathBuf) -> Rc<dyn AdapterFactory> {
    // Each draw is 32 copies of the next number, so every attempt has its own verifier and state.
    let draws = Cell::new(0u8);
    // The fake listens on 127.0.0.1. Its name also gets ::1, where nothing listens, as
    // Google's names have both kinds of address, so every request takes the client's
    // dual-stack path: try IPv6, fall back to IPv4.
    let port: u16 = url
        .rsplit(':')
        .next()
        .and_then(|port| port.trim_end_matches('/').parse().ok())
        .unwrap_or_else(|| panic!("--gmail {url:?} does not end in a port"));
    let base = format!("http://{FAKE_GMAIL_HOST}:{port}");
    let addresses = vec![
        SocketAddr::from((Ipv6Addr::LOCALHOST, port)),
        SocketAddr::from((Ipv4Addr::LOCALHOST, port)),
    ];
    gmail_factory(GmailConfig {
        api_base: base.clone(),
        // Never fetched. The fake reads the consent URL the scenario hands it.
        auth_url: "https://consent.fake.test/o/oauth2/v2/auth".to_owned(),
        token_url: format!("{base}/token"),
        hosts: vec![(FAKE_GMAIL_HOST.to_owned(), addresses)],
        client_id: "letterbox-scenarios.apps.fake.test".to_owned(),
        client_secret: Some("not-a-secret".to_owned()),
        loopback: Loopback::Unix {
            dir: redirects,
            first_port: 47_000,
        },
        random: Rc::new(move || {
            draws.set(draws.get().wrapping_add(1));
            [draws.get(); 32]
        }),
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
    // Time is on for the Gmail adapter's HTTP client (see GmailFactory::new). Nothing in the
    // core or the adapters waits on a timer, so a run still repeats.
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_io()
        .enable_time()
        .build()
        .expect("a single-thread runtime starts");

    let mut factories = args.sim.as_deref().map(sim_adapter_factories).unwrap_or_default();
    factories.extend(args.gmail.map(|(url, redirects)| fake_gmail(url, redirects)));

    LocalSet::new().block_on(&runtime, async move {
        let options = CoreOptions {
            secrets: Box::new(FileKeychain::new(args.data.join(KEYCHAIN_FILE))),
            data_path: args.data,
            env: Box::new(env),
            factories,
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
