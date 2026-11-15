//! Time comes into the core through this one trait, so a test run can fix it
//! and produce the same transcript every time. Nothing else in the core may read
//! the wall clock or make a random value. clippy.toml's disallowed-methods
//! enforces that. Ids need no randomness: the store counts them (see store.rs).

use std::cell::Cell;

use chrono::{DateTime, SecondsFormat, Utc};
use letterbox_protocol::Time;

pub trait Environment {
    /// The current time.
    fn now(&self) -> Time;
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
}

/// A clock that starts at `start` and moves forward one second on each read.
/// Used by the harness so every run is repeatable and events stay in order.
pub struct FixedEnvironment {
    millis: Cell<i64>,
}

impl FixedEnvironment {
    /// `start` is an RFC 3339 time, for example "2026-01-01T00:00:00.000Z".
    pub fn new(start: &str) -> Result<Self, chrono::ParseError> {
        let start = DateTime::parse_from_rfc3339(start)?;
        Ok(Self {
            millis: Cell::new(start.timestamp_millis()),
        })
    }
}

impl Environment for FixedEnvironment {
    fn now(&self) -> Time {
        let millis = self.millis.get() + 1000;
        self.millis.set(millis);
        let at = DateTime::from_timestamp_millis(millis).expect("the fixed clock stays inside chrono's range");
        iso(at)
    }
}

/// The same text JavaScript's `Date.prototype.toISOString` gives: milliseconds and a Z.
fn iso(at: DateTime<Utc>) -> Time {
    at.to_rfc3339_opts(SecondsFormat::Millis, true)
}
