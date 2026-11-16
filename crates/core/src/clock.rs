//! Time and randomness come into the core through this one trait, so a test run can fix
//! them and produce the same transcript every time. Nothing else in the core may read the
//! wall clock, wait on a timer or make a random value. clippy.toml's disallowed-methods
//! enforces that. Record ids need no randomness: the store counts them (see store.rs).

use std::cell::Cell;
use std::hash::{BuildHasher, RandomState};
use std::time::Duration;

use chrono::{DateTime, SecondsFormat, Utc};
use letterbox_protocol::Time;

use crate::adapter::LocalFuture;

pub trait Environment {
    /// The current time.
    fn now(&self) -> Time;
    /// Resolves once the clock reads `at` or later, at once for a time already past.
    /// The outbox waits on it for each send's undo window (see outbox.rs).
    fn until(&self, at: &Time) -> LocalFuture<'static, ()>;
    /// A number another device is unlikely to draw. Each Message-ID the core writes holds one.
    fn random(&self) -> u64;
}

/// Reads a time the core wrote. A time it cannot read counts as the start of the epoch.
pub fn parse(at: &Time) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(at)
        .map(|at| at.to_utc())
        .unwrap_or_default()
}

/// The real clock. Used when the core runs for a person.
pub struct SystemEnvironment;

impl Environment for SystemEnvironment {
    #[expect(
        clippy::disallowed_methods,
        reason = "this is the one place the core reads the wall clock"
    )]
    fn now(&self) -> Time {
        iso(Utc::now())
    }

    #[expect(
        clippy::disallowed_methods,
        reason = "this is the one place the core waits on the wall clock"
    )]
    fn until(&self, at: &Time) -> LocalFuture<'static, ()> {
        let wait = (parse(at) - Utc::now()).to_std().unwrap_or_default();
        Box::pin(tokio::time::sleep(wait))
    }

    fn random(&self) -> u64 {
        // std seeds every RandomState from the system's random source, so its hash of a constant is random.
        RandomState::new().hash_one(0u8)
    }
}

/// A clock that starts at `start` and moves forward one second on each read. Waiting
/// moves it to the end of the wait at once, so no run waits on real time. Used by the
/// harness so every run is repeatable and events stay in order.
pub struct FixedEnvironment {
    millis: Cell<i64>,
    draws: Cell<u64>,
    /// Waits this long or longer never end (see `holding_from`).
    hold: Option<Duration>,
}

impl FixedEnvironment {
    /// `start` is an RFC 3339 time, for example "2026-01-01T00:00:00.000Z".
    pub fn new(start: &str) -> Result<Self, chrono::ParseError> {
        let start = DateTime::parse_from_rfc3339(start)?;
        Ok(Self {
            millis: Cell::new(start.timestamp_millis()),
            draws: Cell::new(0),
            hold: None,
        })
    }

    /// Makes a wait of `wait` or longer hold for as long as the core runs, so a scenario
    /// can act inside it. Shorter waits still end at once.
    #[must_use]
    pub fn holding_from(self, wait: Duration) -> Self {
        Self {
            hold: Some(wait),
            ..self
        }
    }
}

impl Environment for FixedEnvironment {
    fn now(&self) -> Time {
        let millis = self.millis.get() + 1000;
        self.millis.set(millis);
        let at = DateTime::from_timestamp_millis(millis).expect("the fixed clock stays inside chrono's range");
        iso(at)
    }

    fn until(&self, at: &Time) -> LocalFuture<'static, ()> {
        let end = parse(at).timestamp_millis();
        let gap = u64::try_from(end - self.millis.get()).unwrap_or_default();
        if self.hold.is_some_and(|hold| Duration::from_millis(gap) >= hold) {
            return Box::pin(std::future::pending());
        }
        self.millis.set(self.millis.get().max(end));
        Box::pin(std::future::ready(()))
    }

    fn random(&self) -> u64 {
        self.draws.set(self.draws.get() + 1);
        self.draws.get()
    }
}

/// The same text JavaScript's `Date.prototype.toISOString` gives: milliseconds and a Z.
pub fn iso(at: DateTime<Utc>) -> Time {
    at.to_rfc3339_opts(SecondsFormat::Millis, true)
}
