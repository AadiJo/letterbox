//! The core as a process, wired to the sim provider. This is what every scenario
//! talks to: one JSON message per line on stdin, one per line on stdout.
//!
//!   core-sim --data <folder> [--sim <socket>] [--gmail <url> --gmail-redirects <folder>] [--now <time>]
//!            [--undo-window <seconds>] [--confirm-window <seconds>] [--hold-waits]
//!
//! `--sim` lists the two sim provider options. `--gmail` adds the Gmail option, pointed at
//! the fake Gmail server at `<url>` (packages/sim-provider/src/gmail). Its consent URLs must
//! not change between runs, so its random source and loopback port are fixed here, and the
//! browser's redirect arrives on a unix socket in `--gmail-redirects`. At least one is needed.
//!
//! The clock is fixed (`--now`) and a wait on it ends at once, so a send's undo window
//! (`--undo-window`, 10 seconds unless given) and its confirm window (`--confirm-window`,
//! 60 seconds unless given) take no real time. A wait of HELD_WAIT or longer holds for as
//! long as this core runs, so a scenario can act inside it. `--hold-waits` holds every wait,
//! so a scenario can act after the clock passes a deadline and before the timer for it runs.
//!
//! packages/harness builds it and starts one per scenario, or more to test a restart.
//! The real app's program is `letterbox-core` in crates/host, which owns the stdio loop
//! both run through. Nothing here is test logic inside the core: this file only chooses
//! which factories, clock and secret store it gets.

use std::cell::Cell;
use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr};
use std::path::PathBuf;
use std::process::ExitCode;
use std::rc::Rc;
use std::time::Duration;

use letterbox_core::adapter::{AdapterFactory, LocalFuture};
use letterbox_core::clock::FixedEnvironment;
use letterbox_gmail::{GmailConfig, Loopback, gmail_factory};
use letterbox_host::{Parts, run_stdio};
use letterbox_sim_client::{FileKeychain, sim_adapter_factories};

const USAGE: &str = "usage: core-sim --data <folder> [--sim <socket>] [--gmail <url> --gmail-redirects <folder>] \
                     [--now <time>] [--undo-window <seconds>] [--confirm-window <seconds>] [--hold-waits]";

/// The file in the data folder that stands in for the keychain. The harness reads it by
/// this name (SIM_KEYCHAIN in packages/harness/src/invariants.ts).
const KEYCHAIN_FILE: &str = "sim-keychain.json";

/// A rate-limit wait this long or longer holds until the adapter closes, and an undo window
/// this long holds while the core runs. Shorter ones end at once. A scenario reaches a held
/// rate-limit wait by having the fake send a Retry-After of an hour.
const HELD_WAIT: Duration = Duration::from_secs(3600);

/// Written to stderr when a wait starts to hold, so a scenario knows the adapter is waiting.
const WAIT_HELD: &str = "core-sim: holding a gmail rate-limit wait until the adapter closes";

/// Written to stderr as every wait begins, before its length in milliseconds, so a scenario
/// can check the backoff the adapter asked for.
const WAIT_BEGUN: &str = "core-sim: gmail rate-limit wait of";

/// The name core-sim reaches the fake Gmail server by. It resolves only through `GmailConfig::hosts`.
const FAKE_GMAIL_HOST: &str = "gmail.fake.test";

struct Args {
    data: PathBuf,
    sim: Option<PathBuf>,
    gmail: Option<(String, PathBuf)>,
    now: String,
    undo_window: Duration,
    confirm_window: Duration,
    hold_waits: bool,
}

fn parse_args() -> Option<Args> {
    let mut data = None;
    let mut sim = None;
    let mut gmail = None;
    let mut redirects = None;
    let mut now = "2026-01-01T00:00:00.000Z".to_owned();
    let mut undo_window = Duration::from_secs(10);
    let mut confirm_window = Duration::from_secs(60);
    let mut hold_waits = false;
    let mut args = std::env::args().skip(1);
    while let Some(flag) = args.next() {
        if flag == "--hold-waits" {
            hold_waits = true;
            continue;
        }
        let value = args.next()?;
        match flag.as_str() {
            "--data" => data = Some(PathBuf::from(value)),
            "--sim" => sim = Some(PathBuf::from(value)),
            "--gmail" => gmail = Some(value),
            "--gmail-redirects" => redirects = Some(PathBuf::from(value)),
            "--now" => now = value,
            "--undo-window" => undo_window = Duration::from_secs(value.parse().ok()?),
            "--confirm-window" => confirm_window = Duration::from_secs(value.parse().ok()?),
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
        undo_window,
        confirm_window,
        hold_waits,
    })
}

/// The Gmail option, pointed at the fake server. Nothing here is a real client: the fake
/// accepts any client id, as long as the code exchange names the one consent did. No wait
/// takes real time, so a run repeats and its transcript holds nothing about time.
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
        // Each call on a new connection, so a call made while the fake is offline surely fails at connect.
        reuse_connections: false,
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
        pause: Rc::new(pause),
    })
}

/// core-sim's rate-limit wait. It takes no real time: it ends at once, or holds for good.
#[expect(
    clippy::disallowed_macros,
    reason = "core-sim owns stderr for its log, which the harness reads"
)]
fn pause(wait: Duration) -> LocalFuture<'static, ()> {
    eprintln!("{WAIT_BEGUN} {} ms", wait.as_millis());
    if wait < HELD_WAIT {
        return Box::pin(std::future::ready(()));
    }
    eprintln!("{WAIT_HELD}");
    Box::pin(std::future::pending())
}

#[expect(
    clippy::disallowed_macros,
    reason = "core-sim says on stderr why it cannot start. The protocol has not begun"
)]
fn main() -> ExitCode {
    let Some(args) = parse_args() else {
        eprintln!("{USAGE}");
        return ExitCode::from(2);
    };
    let env = match FixedEnvironment::new(&args.now) {
        Ok(env) => env.holding_from(if args.hold_waits { Duration::ZERO } else { HELD_WAIT }),
        Err(error) => {
            eprintln!("--now: {error}\n{USAGE}");
            return ExitCode::from(2);
        }
    };
    let mut factories = args.sim.as_deref().map(sim_adapter_factories).unwrap_or_default();
    factories.extend(args.gmail.map(|(url, redirects)| fake_gmail(url, redirects)));
    // run_stdio turns time on for the Gmail adapter's HTTP client (see GmailFactory::new).
    // Nothing in the core or the adapters waits on a timer, so a run still repeats.
    run_stdio(
        "core-sim",
        Parts {
            secrets: Box::new(FileKeychain::new(args.data.join(KEYCHAIN_FILE))),
            data_path: args.data,
            env: Box::new(env),
            factories,
            undo_window: args.undo_window,
            confirm_window: args.confirm_window,
        },
    )
}
