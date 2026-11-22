//! Time and randomness come into the core through this one trait, so a test run can fix
//! them and produce the same transcript every time. Nothing else in the core may read the
//! wall clock, wait on a timer or make a random value. clippy.toml's disallowed-methods
//! enforces that. Record ids need no randomness: the store counts them (see store.rs).

use std::cell::Cell;
use std::hash::{BuildHasher, RandomState};
use std::time::Duration;

use chrono::{DateTime, SecondsFormat, TimeDelta, Utc};
use letterbox_protocol::Time;
use tokio::sync::watch;

use crate::adapter::LocalFuture;

pub trait Environment {
    /// The current time.
    fn now(&self) -> Time;
    /// Resolves once the clock reads `at` or later, at once for a time already past.
    /// The outbox waits on it for each send's undo window (see outbox.rs).
    fn until(&self, at: &Time) -> LocalFuture<'static, ()>;
    /// Like `until`, and resolves too once the clock reads earlier than `since`: it was set
    /// back, so what was worked out at `since` is out of date. The lists that split on age wait
    /// on it for their next crossing (`book_wake` in subscriptions.rs).
    fn until_or_back(&self, at: &Time, since: &Time) -> LocalFuture<'static, ()>;
    /// A wait for work the core starts on its own while idle: the sync schedule's next pull
    /// (schedule.rs). Resolves after `wait`, and early once the clock jumps: forward past the
    /// end, as it reads when the machine wakes from a suspend, or back. A test clock ends it only
    /// when the test moves the clock (see `FixedEnvironment::moved_by`), so a run that never
    /// moves it never sees the core act on its own.
    fn idle(&self, wait: Duration) -> LocalFuture<'static, ()>;
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

/// How long the real clock's waits sleep before they read the wall clock again. A sleep runs on
/// a clock that stops while the machine is suspended and does not follow the wall clock when it
/// is set, so a wait that slept its whole length at once could end days late.
const RECHECK: Duration = Duration::from_secs(60);

/// How often an idle wait reads the wall clock again. An idle wait is about as long as RECHECK,
/// so RECHECK would let a machine that wakes from a suspend past the wait's end sleep out the
/// rest of it first. Reading every few seconds pulls within seconds of the wake instead.
const IDLE_RECHECK: Duration = Duration::from_secs(5);

/// Waits until the wall clock reads `at`, or reads earlier than `since` when given, reading
/// it again at least every `recheck`.
#[expect(
    clippy::disallowed_methods,
    reason = "this is the one place the core waits on the wall clock"
)]
fn wall_clock_wait(at: &Time, since: Option<&Time>, recheck: Duration) -> LocalFuture<'static, ()> {
    let (at, since) = (parse(at), since.map(parse));
    Box::pin(async move {
        loop {
            let now = Utc::now();
            if now >= at || since.is_some_and(|since| now < since) {
                return;
            }
            let left = (at - now).to_std().unwrap_or_default();
            tokio::time::sleep(left.min(recheck)).await;
        }
    })
}

impl Environment for SystemEnvironment {
    #[expect(
        clippy::disallowed_methods,
        reason = "this is the one place the core reads the wall clock"
    )]
    fn now(&self) -> Time {
        iso(Utc::now())
    }

    fn until(&self, at: &Time) -> LocalFuture<'static, ()> {
        wall_clock_wait(at, None, RECHECK)
    }

    fn until_or_back(&self, at: &Time, since: &Time) -> LocalFuture<'static, ()> {
        wall_clock_wait(at, Some(since), RECHECK)
    }

    fn idle(&self, wait: Duration) -> LocalFuture<'static, ()> {
        let since = self.now();
        let length = TimeDelta::from_std(wait).unwrap_or(TimeDelta::MAX);
        let at = parse(&since)
            .checked_add_signed(length)
            .unwrap_or(DateTime::<Utc>::MAX_UTC);
        wall_clock_wait(&iso(at), Some(&since), IDLE_RECHECK)
    }

    fn random(&self) -> u64 {
        // std seeds every RandomState from the system's random source, so its hash of a constant is random.
        RandomState::new().hash_one(0u8)
    }
}

/// A clock that starts at `start` and moves forward one second on each read. Waiting
/// moves it to the end of the wait at once, so no run waits on real time. Used by the
/// harness so every run is repeatable and events stay in order.
///
/// An idle wait is the exception: it never ends on its own, or the core's schedule would pull
/// again and again without end. A test that wants the core to act on its own moves the clock
/// with a `ClockHand` (see `moved_by`).
pub struct FixedEnvironment {
    millis: Cell<i64>,
    draws: Cell<u64>,
    /// Waits this long or longer never end (see `holding_from`).
    hold: Option<Duration>,
    /// The hand that moves the clock, when a test holds one (see `moved_by`).
    moves: Option<Moves>,
}

/// How far a `ClockHand` has moved the clock, and how many times.
#[derive(Clone, Copy, Default)]
struct Moved {
    count: u64,
    by: Duration,
}

/// What a FixedEnvironment knows of its hand: the moves made, the ones its clock already
/// shows, and what to tell as each idle wait begins.
struct Moves {
    seen: watch::Receiver<Moved>,
    applied: Cell<Moved>,
    begun: Box<dyn Fn(Duration)>,
}

/// Moves a FixedEnvironment's clock forward while the core runs, from any thread. core-sim
/// holds one for the harness, which moves the clock to let the core's idle waits end.
#[derive(Default)]
pub struct ClockHand {
    moved: watch::Sender<Moved>,
}

impl ClockHand {
    /// Moves the clock forward by `by`. Each idle wait that has now seen the clock move by its
    /// length since it began ends. A move of zero ends only those of zero, which are due at once.
    pub fn advance(&self, by: Duration) {
        self.moved.send_modify(|moved| {
            moved.count += 1;
            moved.by = moved.by.saturating_add(by);
        });
    }
}

impl FixedEnvironment {
    /// `start` is an RFC 3339 time, for example "2026-01-01T00:00:00.000Z".
    pub fn new(start: &str) -> Result<Self, chrono::ParseError> {
        let start = DateTime::parse_from_rfc3339(start)?;
        Ok(Self {
            millis: Cell::new(start.timestamp_millis()),
            draws: Cell::new(0),
            hold: None,
            moves: None,
        })
    }

    /// Lets `hand` move this clock forward. An idle wait then ends once the hand has moved the
    /// clock by the wait's length since it began, and `begun` is told each wait's length as it
    /// begins, so a test can see what the core waits for and when it waits again.
    #[must_use]
    pub fn moved_by(self, hand: &ClockHand, begun: impl Fn(Duration) + 'static) -> Self {
        Self {
            moves: Some(Moves {
                seen: hand.moved.subscribe(),
                applied: Cell::new(Moved::default()),
                begun: Box::new(begun),
            }),
            ..self
        }
    }

    /// Puts the moves the hand made since the last call on the clock, and returns them all.
    fn catch_up(&self) -> Moved {
        let Some(moves) = &self.moves else {
            return Moved::default();
        };
        let moved = *moves.seen.borrow();
        let added = moved.by.saturating_sub(moves.applied.get().by);
        let added = i64::try_from(added.as_millis()).unwrap_or(i64::MAX);
        self.millis.set(self.millis.get().saturating_add(added));
        moves.applied.set(moved);
        moved
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
        self.catch_up();
        let millis = self.millis.get() + 1000;
        self.millis.set(millis);
        let at = DateTime::from_timestamp_millis(millis).expect("the fixed clock stays inside chrono's range");
        iso(at)
    }

    fn until(&self, at: &Time) -> LocalFuture<'static, ()> {
        self.catch_up();
        let end = parse(at).timestamp_millis();
        let gap = u64::try_from(end - self.millis.get()).unwrap_or_default();
        if self.hold.is_some_and(|hold| Duration::from_millis(gap) >= hold) {
            return Box::pin(std::future::pending());
        }
        self.millis.set(self.millis.get().max(end));
        Box::pin(std::future::ready(()))
    }

    /// The fixed clock never goes back, so this waits as `until` does.
    fn until_or_back(&self, at: &Time, _since: &Time) -> LocalFuture<'static, ()> {
        self.until(at)
    }

    /// Holds until the hand moves the clock by `wait`, for good when there is no hand. It moves
    /// nothing itself and reads no time, so a run whose test never moves the clock goes as it
    /// would if the core had no idle waits at all.
    fn idle(&self, wait: Duration) -> LocalFuture<'static, ()> {
        let Some(moves) = &self.moves else {
            return Box::pin(std::future::pending());
        };
        let begun = self.catch_up();
        (moves.begun)(wait);
        let mut seen = moves.seen.clone();
        Box::pin(async move {
            loop {
                if seen.changed().await.is_err() {
                    // The hand is gone, so the clock moves no more.
                    return std::future::pending().await;
                }
                let moved = *seen.borrow_and_update();
                if moved.count > begun.count && moved.by.saturating_sub(begun.by) >= wait {
                    return;
                }
            }
        })
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
