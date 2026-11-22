//! The sync schedule. The core pulls from each signed-in account's provider on its own, so mail
//! comes in, and `your-turn` is told (notify.rs), while the app runs and nobody asks for a sync.
//!
//! Each link (see `Linked` in lib.rs) has one schedule, a task that waits on the clock
//! (`Environment::idle`), then queues a pass that pulls and waits again:
//!   - At start it pulls at once: a saved cursor makes the pull a change set of what came while
//!     the app was quit, which notify.rs's `CatchUp` keeps quiet. After a sign-in it waits for
//!     the sign-in's pull, and any backfill it starts, to end, then PERIOD.
//!   - Each wait starts once the pull before it, and any backfill that pull starts, has ended.
//!     It is PERIOD while pulls go well. Each failed pull in a row doubles it, up to MOST. After
//!     a pull that needs a sign-in it waits only for the health to clear: a new sign-in links
//!     anew, with a schedule of its own.
//!   - An idle wait ends early when the wall clock jumps, as it does when the machine wakes from
//!     a suspend, so the pull comes then and not a period later.
//!   - When the account's health clears, because some other call reached the provider, the
//!     network is back: it pulls at once, through a wait of zero. A pull that failed while
//!     another call cleared the health counts as cleared too, as no wait was there to be woken.
//!   - It starts no pull while another one is queued or running for the account (`pulls`, see
//!     `Inner::pulling` in queue.rs), or a backfill's next page is queued: that pull does the
//!     work. It waits PERIOD more instead.
//!   - Its pulls are quiet (`Pull::Quiet` in sync.rs): the accounts view shows syncing only when
//!     one lists a snapshot, not for a change set that mostly brings nothing.
//!
//! A schedule ends when its link stops: a sign-out or a new sign-in unlinks it, or the core
//! closes. A pass it queued that has not started then does not start, so it never runs after
//! close begins or on the adapter of the link that replaced its own. A schedule counts as work
//! in the core's TaskTracker, so `Core::close` waits for it to end, which the stop makes at once.
//!
//! Every wait goes through the environment, so the harness's fixed clock holds each one until
//! the scenario moves the clock (see `FixedEnvironment::moved_by`).

use std::rc::Rc;
use std::time::Duration;

use letterbox_protocol::AccountId;
use tokio::sync::oneshot;

use crate::adapter::AdapterFailure;
use crate::sync::{Joined, PassResult, Pull};
use crate::world::Health;
use crate::{Inner, Linked};

/// How long an account waits between pulls while they go well. A pull that finds nothing new
/// costs 3 quota units (Gmail's `history.list` and `labels.list`) of the 250 a user may spend
/// each second, so a minute keeps mail current to within a minute at a tiny share of the quota.
/// A rate limit is waited out inside the call (crates/gmail), and the pass stays queued and
/// counted meanwhile, so no pull piles up behind it.
pub(crate) const PERIOD: Duration = Duration::from_secs(60);

/// The longest wait between pulls that fail. Offline, a pull costs nothing at the provider, and
/// five minutes is as late as mail should come once the network is back with nothing else to
/// say so. A provider that keeps failing is asked no more than that.
const MOST: Duration = Duration::from_secs(300);

/// Where a schedule starts.
pub(crate) enum Start {
    /// With a pull due at once: an account the core resumed at start.
    Now,
    /// Once this pull, a sign-in's, has ended.
    After(oneshot::Receiver<Joined>),
}

/// How a schedule's wait ended.
enum Woke {
    /// The time for the next pull came.
    Due,
    /// The account's health cleared: the provider can be reached again.
    Cleared,
    /// The link stopped.
    Stopped,
}

impl Inner {
    /// Starts the schedule of the account `linked` serves. lib.rs starts one for each account
    /// it resumes at start, and accounts.rs one for each sign-in.
    pub(crate) fn schedule(self: &Rc<Self>, account_id: AccountId, linked: Linked, start: Start) {
        self.work
            .spawn_local(Rc::clone(self).run_schedule(account_id, linked, start));
    }

    /// The schedule's loop. It ends once `linked` stops.
    async fn run_schedule(self: Rc<Self>, account_id: AccountId, linked: Linked, start: Start) {
        let mut failures = 0;
        let mut wait = match start {
            Start::Now => Some(Duration::ZERO),
            Start::After(first) => {
                let joined = tokio::select! {
                    biased;
                    () = linked.stop.cancelled() => return,
                    joined = first => joined.expect("a queued pass runs to its end, since a panic ends the program"),
                };
                let Some(ended) = self.ended(joined, &linked).await else {
                    return;
                };
                self.next_wait(&account_id, ended, &mut failures)
            }
        };
        loop {
            // Registered before the wait begins, so health that clears while it runs wakes it.
            let cleared = linked.wake.notified();
            let due = async {
                match wait {
                    Some(wait) => self.env.idle(wait).await,
                    None => std::future::pending().await,
                }
            };
            let woke = tokio::select! {
                biased;
                () = linked.stop.cancelled() => Woke::Stopped,
                () = cleared => Woke::Cleared,
                () = due => Woke::Due,
            };
            match woke {
                Woke::Stopped => return,
                Woke::Cleared => {
                    failures = 0;
                    wait = Some(Duration::ZERO);
                    continue;
                }
                Woke::Due => {}
            }
            let busy = self.state.borrow().pulls.contains_key(&account_id) || self.backfilling(&account_id);
            if busy {
                wait = Some(PERIOD);
                continue;
            }
            let Some(ended) = self.scheduled_pull(&account_id, &linked).await else {
                return;
            };
            wait = self.next_wait(&account_id, ended, &mut failures);
        }
    }

    /// Queues one quiet pull, and hands back how it ended once it has, a backfill it starts
    /// included. None when the link stopped first, even while the pull waits in the queue.
    ///
    /// The pass checks again as it reaches the head of the queue, and does not pull when the
    /// link stopped, or when a pull ended well since the tick: a job queued ahead of it can turn
    /// into one, as a push does that pulls first to settle a change whose answer was lost.
    async fn scheduled_pull(self: &Rc<Self>, account_id: &AccountId, linked: &Linked) -> Option<PassResult> {
        let core = Rc::clone(self);
        let (id, link) = (account_id.clone(), linked.clone());
        let ticked = self.pulls_ended_well(account_id);
        let pass = self.enqueue_pull(account_id, async move {
            let pulled_since = core.pulls_ended_well(&id) != ticked;
            if link.stop.is_cancelled() || !core.still_current(&id, &link) || pulled_since {
                return None;
            }
            Some(core.sync_pass(id, Pull::Quiet).await)
        });
        let ran = tokio::select! {
            biased;
            () = linked.stop.cancelled() => return None,
            ran = pass => ran.expect("a queued pass runs to its end, since a panic ends the program"),
        };
        match ran {
            Some(joined) => self.ended(joined, linked).await,
            // It did not pull: another pull did the work, or the link stopped, which the
            // schedule sees as it waits next.
            None => Some(Ok(())),
        }
    }

    /// How a pull ended: its backfill's end when it left one, else its own. None when the link
    /// stopped while the backfill ran.
    async fn ended(&self, (ran, backfill, _): Joined, linked: &Linked) -> Option<PassResult> {
        let Some(backfill) = backfill else {
            return Some(ran.unwrap_or(Ok(())));
        };
        tokio::select! {
            biased;
            () = linked.stop.cancelled() => None,
            // A backfill whose page never ran, as at close, said nothing worth backing off for.
            ended = backfill => Some(ended.unwrap_or(Ok(()))),
        }
    }

    /// The wait before the next pull, after one that ended with `ended`. `failures` counts the
    /// failed pulls in a row. Health that reads clear after a failure was cleared by a call
    /// that ran before the schedule resumed, with no wait to wake, so the pull is due at once.
    fn next_wait(&self, account_id: &AccountId, ended: PassResult, failures: &mut u32) -> Option<Duration> {
        let healthy = {
            let state = self.state.borrow();
            let account = state.world.accounts.get(account_id);
            account.is_some_and(|account| account.health == Health::Ok)
        };
        match ended {
            Ok(()) => {
                *failures = 0;
                Some(PERIOD)
            }
            Err(_) if healthy => {
                *failures = 0;
                Some(Duration::ZERO)
            }
            Err(AdapterFailure::NeedsSignIn) => None,
            Err(_) => {
                *failures += 1;
                Some(PERIOD.saturating_mul(2_u32.saturating_pow(*failures)).min(MOST))
            }
        }
    }
}
