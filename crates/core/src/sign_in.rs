//! The sign-in lifecycle. One attempt per sign-in option runs at a time, and a newer
//! attempt supersedes the one before it. Every attempt ends in exactly one answer
//! (guarantee 7): `outcome` decides which, and the core answers each `Outcome` once.

use letterbox_protocol::SignInOptionId;
use tokio_util::sync::CancellationToken;

use crate::adapter::{Connection, SignInFailure};
use crate::maps::HashMap;

/// One attempt's handles. Clones share them.
#[derive(Clone)]
pub struct Attempt {
    /// Tells this attempt apart from a newer one for the same option.
    number: u64,
    /// Cancelled when a newer attempt starts or the core closes. The adapter then answers `cancelled`.
    pub signal: CancellationToken,
    /// Cancelled once this attempt has its answer. The attempt after it waits for that, so
    /// two answers for one option always arrive in the order they were asked.
    pub answered: CancellationToken,
}

/// The newest attempt for each sign-in option. Whether an attempt is superseded is read
/// from here, so there is no second copy of that fact to fall out of step.
#[derive(Default)]
pub struct Attempts {
    newest: HashMap<SignInOptionId, Attempt>,
    started: u64,
}

impl Attempts {
    /// Starts an attempt for `option` and supersedes the one before it, if any. Returns the
    /// new attempt and the one it superseded, whose answer the new one must wait for.
    pub fn start(&mut self, option: &SignInOptionId) -> (Attempt, Option<Attempt>) {
        self.started += 1;
        let attempt = Attempt {
            number: self.started,
            signal: CancellationToken::new(),
            answered: CancellationToken::new(),
        };
        let prior = self.newest.insert(option.clone(), attempt.clone());
        if let Some(prior) = &prior {
            prior.signal.cancel();
        }
        (attempt, prior)
    }

    /// True while no newer attempt for `option` has started.
    pub fn is_newest(&self, option: &SignInOptionId, attempt: &Attempt) -> bool {
        self.newest
            .get(option)
            .is_some_and(|newest| newest.number == attempt.number)
    }

    /// Records that `attempt` has had its answer, and forgets it unless a newer one replaced it.
    pub fn answered(&mut self, option: &SignInOptionId, attempt: &Attempt) {
        if self.is_newest(option, attempt) {
            self.newest.remove(option);
        }
        attempt.answered.cancel();
    }

    /// Cancels every attempt, so each one answers `cancelled` instead of waiting for the user.
    pub fn cancel_all(&self) {
        for attempt in self.newest.values() {
            attempt.signal.cancel();
        }
    }
}

/// How a sign-in attempt ends.
pub enum Outcome {
    /// A newer attempt for the same option took over. A connection it made is closed unused.
    Superseded(Option<Connection>),
    Failed(SignInFailure),
    SignedIn(Connection),
}

/// Decides how an attempt ends, from whether it is still the newest and what the provider answered.
pub fn outcome(newest: bool, answer: Result<Connection, SignInFailure>) -> Outcome {
    match (newest, answer) {
        (false, answer) => Outcome::Superseded(answer.ok()),
        (true, Ok(connection)) => Outcome::SignedIn(connection),
        (true, Err(failure)) => Outcome::Failed(failure),
    }
}
