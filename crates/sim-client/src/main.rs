//! The core as a process, wired to the sim provider. This is what every scenario
//! talks to: one JSON message per line on stdin, one per line on stdout.
//!
//!   core-sim --data <folder> [--sim <socket>] [--gmail <url> --gmail-redirects <folder>]
//!            [--gmail-timeouts <call>,<transfer>,<stall>] [--now <time>] [--undo-window <seconds>]
//!            [--confirm-window <seconds>] [--hold-waits] [--clock <socket>]
//!
//! `--sim` lists the two sim provider options. `--gmail` adds the Gmail option, pointed at
//! the fake Gmail server at `<url>` (packages/sim-provider/src/gmail). Its consent URLs must
//! not change between runs, so its random source and loopback port are fixed here, and the
//! browser's redirect arrives on a unix socket in `--gmail-redirects`. At least one is needed.
//! `--sim` works everywhere (a named pipe on Windows). `--gmail` needs unix sockets, so on
//! Windows core-sim refuses it, and the scenarios that use it run on Linux and macOS only.
//! Its requests get Google's time budgets unless `--gmail-timeouts` gives seconds for them, as a
//! scenario that stalls an answer does, so the call fails inside its wait (see
//! packages/harness/scenarios/28-gmail-deadlines.ts).
//!
//! The clock is fixed (`--now`) and a wait on it ends at once, so a send's undo window
//! (`--undo-window`, 10 seconds unless given) and its confirm window (`--confirm-window`,
//! 60 seconds unless given) take no real time. A wait of HELD_WAIT or longer holds for as
//! long as this core runs, so a scenario can act inside it. `--hold-waits` holds every wait,
//! so a scenario can act after the clock passes a deadline and before the timer for it runs.
//!
//! The core's idle waits, such as its sync schedule's, never end on the fixed clock by
//! themselves. `--clock` names a unix socket core-sim listens on: each line written to it is a
//! number of seconds to move the clock forward, which ends the idle waits that have seen the
//! clock move by their length (see `FixedEnvironment::moved_by`). Zero ends those due at once.
//! As each idle wait begins, core-sim writes IDLE_BEGUN, its length, and how far the clock had
//! been moved by then, to stderr, and SCHEDULE_NOTED with each decision the schedule makes. Only unix
//! has `--clock`. The harness runs scenarios there.
//!
//! packages/harness builds it and starts one per scenario, or more to test a restart.
//! The real app's program is `letterbox-core` in crates/host, which owns the stdio loop
//! both run through. Nothing here is test logic inside the core: this file only chooses
//! which factories, clock and secret store it gets.

#[cfg(unix)]
use std::cell::Cell;
#[cfg(unix)]
use std::io::{BufRead, BufReader};
#[cfg(unix)]
use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr};
#[cfg(unix)]
use std::os::unix::net::UnixListener;
use std::path::PathBuf;
use std::process::ExitCode;
#[cfg(unix)]
use std::rc::Rc;
use std::time::Duration;

#[cfg(unix)]
use letterbox_core::adapter::{AdapterFactory, LocalFuture};
#[cfg(unix)]
use letterbox_core::clock::ClockHand;
use letterbox_core::clock::FixedEnvironment;
#[cfg(unix)]
use letterbox_gmail::{GOOGLE_TIMEOUTS, GmailConfig, Loopback, Timeouts, gmail_factory};
use letterbox_host::{Parts, run_stdio};
use letterbox_sim_client::{FileKeychain, sim_adapter_factories};

const USAGE: &str = "usage: core-sim --data <folder> [--sim <socket>] [--gmail <url> --gmail-redirects <folder>] \
                     [--gmail-timeouts <call>,<transfer>,<stall>] [--now <time>] [--undo-window <seconds>] \
                     [--confirm-window <seconds>] [--hold-waits] [--clock <socket>]";

/// The file in the data folder that stands in for the keychain. The harness reads it by
/// this name (SIM_KEYCHAIN in packages/harness/src/invariants.ts).
const KEYCHAIN_FILE: &str = "sim-keychain.json";

/// A rate-limit wait this long or longer holds until the adapter closes, and an undo window
/// this long holds while the core runs. Shorter ones end at once. A scenario reaches a held
/// rate-limit wait by having the fake send a Retry-After of an hour.
const HELD_WAIT: Duration = Duration::from_secs(3600);

/// Written to stderr when a wait starts to hold, so a scenario knows the adapter is waiting.
#[cfg(unix)]
const WAIT_HELD: &str = "core-sim: holding a gmail rate-limit wait until the adapter closes";

/// Written to stderr as every wait begins, before its length in milliseconds, so a scenario
/// can check the backoff the adapter asked for.
#[cfg(unix)]
const WAIT_BEGUN: &str = "core-sim: gmail rate-limit wait of";

/// Written to stderr as each idle wait begins, before its length in milliseconds, so a scenario
/// knows what the core waits for, and that it has finished what the last wait started.
#[cfg(unix)]
const IDLE_BEGUN: &str = "core-sim: idle wait of";

/// Written to stderr before the name of each decision the sync schedule makes (`Noted`), so a
/// scenario knows it was made, as a pull being in the queue, before it takes the next step.
#[cfg(unix)]
const SCHEDULE_NOTED: &str = "core-sim: schedule noted";

/// The name core-sim reaches the fake Gmail server by. It resolves only through `GmailConfig::hosts`.
#[cfg(unix)]
const FAKE_GMAIL_HOST: &str = "gmail.fake.test";

struct Args {
    data: PathBuf,
    sim: Option<PathBuf>,
    /// The fake's URL, the redirects folder, and the request budgets `--gmail-timeouts` gave.
    gmail: Option<(String, PathBuf, Option<[u64; 3]>)>,
    now: String,
    undo_window: Duration,
    confirm_window: Duration,
    hold_waits: bool,
    clock: Option<PathBuf>,
}

fn parse_args() -> Option<Args> {
    let mut data = None;
    let mut sim = None;
    let mut gmail = None;
    let mut redirects = None;
    let mut timeouts = None;
    let mut now = "2026-01-01T00:00:00.000Z".to_owned();
    let mut undo_window = Duration::from_secs(10);
    let mut confirm_window = Duration::from_secs(60);
    let mut hold_waits = false;
    let mut clock = None;
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
            "--gmail-timeouts" => {
                let seconds: Vec<u64> = value.split(',').map(str::parse).collect::<Result<_, _>>().ok()?;
                timeouts = Some(<[u64; 3]>::try_from(seconds).ok()?);
            }
            "--now" => now = value,
            "--undo-window" => undo_window = Duration::from_secs(value.parse().ok()?),
            "--confirm-window" => confirm_window = Duration::from_secs(value.parse().ok()?),
            "--clock" => clock = Some(PathBuf::from(value)),
            _ => return None,
        }
    }
    let gmail = match (gmail, redirects) {
        (Some(url), Some(redirects)) => Some((url, redirects, timeouts)),
        (None, None) if timeouts.is_none() => None,
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
        clock,
    })
}

/// Listens on `socket` and moves `hand` by each line's seconds, on a thread of its own, for as
/// long as the process runs. It binds before it returns, so the socket takes connections once
/// the core answers. A line that is not a number of seconds ends the program: the scenario is wrong.
#[expect(
    clippy::disallowed_macros,
    reason = "core-sim says on stderr why the scenario's clock line is wrong"
)]
#[cfg(unix)]
fn follow_clock(socket: &PathBuf, hand: ClockHand) -> std::io::Result<()> {
    let listener = UnixListener::bind(socket)?;
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { return };
            for line in BufReader::new(stream).lines() {
                let Ok(line) = line else { break };
                let Ok(seconds) = line.trim().parse() else {
                    eprintln!("core-sim: --clock takes a number of seconds per line, not {line:?}");
                    std::process::exit(2);
                };
                hand.advance(Duration::from_secs(seconds));
            }
        }
    });
    Ok(())
}

/// The Gmail option, pointed at the fake server. Nothing here is a real client: the fake
/// accepts any client id, as long as the code exchange names the one consent did. No wait
/// takes real time but a request's budget, Google's unless `timeouts` gives seconds for its
/// call, transfer and stall budgets. Only an answer a scenario stalls runs one out, so a run
/// repeats and its transcript holds nothing about time.
#[cfg(unix)]
fn fake_gmail(url: String, redirects: PathBuf, timeouts: Option<[u64; 3]>) -> Rc<dyn AdapterFactory> {
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
        pause: Rc::new(pause),
        timeouts: timeouts.map_or(GOOGLE_TIMEOUTS, |[call, transfer, stall]| Timeouts {
            call: Duration::from_secs(call),
            transfer: Duration::from_secs(transfer),
            stall: Duration::from_secs(stall),
        }),
    })
}

/// core-sim's rate-limit wait. It takes no real time: it ends at once, or holds for good.
#[expect(
    clippy::disallowed_macros,
    reason = "core-sim owns stderr for its log, which the harness reads"
)]
#[cfg(unix)]
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
    // The harness runs scenarios on unix only, so only there does core-sim take clock moves.
    #[cfg(not(unix))]
    if args.clock.is_some() {
        eprintln!("--clock needs unix sockets, and this system has none\n{USAGE}");
        return ExitCode::from(2);
    }
    #[cfg(unix)]
    let env = match &args.clock {
        None => env,
        Some(socket) => {
            let hand = ClockHand::default();
            let env = env.on_noted(|what| eprintln!("{SCHEDULE_NOTED} {}", what.name()));
            let env = env.moved_by(&hand, |wait, moved| {
                eprintln!(
                    "{IDLE_BEGUN} {} ms, after {} ms of moves",
                    wait.as_millis(),
                    moved.as_millis()
                );
            });
            if let Err(error) = follow_clock(socket, hand) {
                eprintln!("--clock: {error}\n{USAGE}");
                return ExitCode::from(2);
            }
            env
        }
    };
    #[cfg(not(unix))]
    if args.gmail.is_some() {
        eprintln!("--gmail needs unix sockets for the browser's redirect, and this system has none\n{USAGE}");
        return ExitCode::from(2);
    }
    let factories = args
        .sim
        .as_deref()
        .map(sim_adapter_factories)
        .unwrap_or_default()
        .into_iter();
    #[cfg(unix)]
    let factories = factories.chain(
        args.gmail
            .map(|(url, redirects, timeouts)| fake_gmail(url, redirects, timeouts)),
    );
    let factories = factories.collect();
    // run_stdio turns time on for the Gmail adapter's HTTP client (see GmailFactory::new).
    // Nothing in the core or the adapters waits on a timer but a request's budget, which only a
    // stalled answer runs out, so a run still repeats.
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
