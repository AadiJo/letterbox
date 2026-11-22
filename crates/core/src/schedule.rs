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
//!   - When the host says the network may be back (`network-back`), an account whose last pull
//!     found its provider offline pulls once SETTLE has passed, if the hint still holds then
//!     and at the head of the queue (`hint_holds`). Else it goes back to the wait the hint cut,
//!     which kept its time. The failures in a row still count, so a pull that finds the
//!     provider offline again backs off as before. One hint at a time settles, and an account
//!     that is not offline, or has a pull under way, ignores it, so a network that flaps brings
//!     each offline account at most one pull per SETTLE, and a healthy one none.
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

use letterbox_protocol::{AccountId, Answer, Empty, RequestId, Response};
use tokio::sync::oneshot;

use crate::adapter::{AdapterFailure, LocalFuture};
use crate::clock::Noted;
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

/// How long an offline account waits to pull after the host says the network may be back. A
/// network that just came back gets a moment to settle, and the hints a resume and a reconnect
/// send together fold into one pull.
const SETTLE: Duration = Duration::from_secs(2);

/// What a scheduled pull came to (see `scheduled_pull`).
enum Tried {
    /// It pulled, or another pull did the work, and ended this way.
    Ended(PassResult),
    /// The hint that brought it no longer held at the head of the queue, so it did not pull.
    HintStale,
    /// The link stopped.
    Stopped,
}

/// What a scheduled job did at the head of the queue.
enum AtHead {
    Pulled(Joined),
    Skipped,
    HintStale,
}

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
    /// The host says the network may be back. The wait goes on unless the hint holds.
    Heard,
    /// A hint's settle ended. The wait goes on unless the hint still holds.
    Settled,
    /// A hint's pull ended this way.
    Pulled(PassResult),
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
            let timer = wait.map(|wait| self.env.idle(wait));
            let mut due = std::pin::pin!(async move {
                match timer {
                    Some(timer) => timer.await,
                    None => std::future::pending().await,
                }
            });
            // A hint taken, as the pulls that had ended when it came, and its settle. The wait it
            // cut goes on beside it, so a hint that no longer holds goes back to that wait's time.
            let mut hint: Option<(u64, LocalFuture<'static, ()>)> = None;
            let woke = loop {
                // Registered before the wait goes on, so health that clears or a hint that comes while it runs wakes it.
                let cleared = linked.wake.notified();
                let network = linked.network.notified();
                let settled = async {
                    match hint.as_mut() {
                        Some((_, settle)) => settle.await,
                        None => std::future::pending().await,
                    }
                };
                let woke = tokio::select! {
                    biased;
                    () = linked.stop.cancelled() => Woke::Stopped,
                    () = cleared => Woke::Cleared,
                    () = network => Woke::Heard,
                    () = settled => Woke::Settled,
                    () = &mut due => Woke::Due,
                };
                match woke {
                    Woke::Heard if hint.is_none() => {
                        let ended = self.pulls_ended(&account_id).ended;
                        if self.hint_holds(&account_id, ended, 0) {
                            hint = Some((ended, self.env.idle(SETTLE)));
                        } else {
                            self.env.noted(Noted::HintIgnored);
                        }
                    }
                    // One hint at a time: the one settling stands for the rest.
                    Woke::Heard => self.env.noted(Noted::HintIgnored),
                    Woke::Settled => {
                        let (ended, _) = hint.take().expect("only a hint taken settles");
                        if !self.hint_holds(&account_id, ended, 0) {
                            self.env.noted(Noted::HintDropped);
                            continue;
                        }
                        match self.scheduled_pull(&account_id, &linked, Some(ended)).await {
                            Tried::Stopped => return,
                            Tried::Ended(ended) => break Woke::Pulled(ended),
                            Tried::HintStale => self.env.noted(Noted::HintDropped),
                        }
                    }
                    woke => break woke,
                }
            };
            match woke {
                Woke::Stopped => return,
                Woke::Cleared => {
                    failures = 0;
                    wait = Some(Duration::ZERO);
                    continue;
                }
                Woke::Pulled(ended) => {
                    wait = self.next_wait(&account_id, ended, &mut failures);
                    continue;
                }
                Woke::Due | Woke::Heard | Woke::Settled => {}
            }
            let busy = self.state.borrow().pulls.contains_key(&account_id) || self.backfilling(&account_id);
            if busy {
                wait = Some(PERIOD);
                continue;
            }
            wait = match self.scheduled_pull(&account_id, &linked, None).await {
                Tried::Stopped => return,
                Tried::Ended(ended) => self.next_wait(&account_id, ended, &mut failures),
                Tried::HintStale => unreachable!("a pull for no hint is never stale"),
            };
        }
    }

    /// Queues one quiet pull, and hands back how it ended once it has, a backfill it starts
    /// included. `Stopped` when the link stopped first, even while the pull waits in the queue.
    ///
    /// The job checks again as it reaches the head of the queue. It does not pull when the
    /// link stopped, nor, for the pull a network-back `hint` brought, when that hint no longer
    /// holds (`HintStale`). A job queued ahead of it can have pulled since the tick, as a push
    /// does that pulls first to settle a change whose answer was lost. Then:
    ///   - when that pull left a backfill, whose next page is queued behind this job, the job
    ///     does not pull, and the backfill's end stands for this pull's, failures included;
    ///   - else when a change is still uncertain, as when that push lost the answer to another
    ///     change after its pull, the job pulls all the same, so the change settles now;
    ///   - else the job does not pull: the account is in step.
    async fn scheduled_pull(self: &Rc<Self>, account_id: &AccountId, linked: &Linked, hint: Option<u64>) -> Tried {
        let core = Rc::clone(self);
        let (id, link) = (account_id.clone(), linked.clone());
        let ticked = self.pulls_ended(account_id).well;
        let pass = self.enqueue_pull(account_id, async move {
            if link.stop.is_cancelled() || !core.still_current(&id, &link) {
                return AtHead::Skipped;
            }
            // This job counts as one of the pulls queued.
            if hint.is_some_and(|ended| !core.hint_holds(&id, ended, 1)) {
                return AtHead::HintStale;
            }
            if core.pulls_ended(&id).well != ticked {
                if let Some(backfill) = core.join_backfill(&id) {
                    return AtHead::Pulled((Some(Ok(())), Some(backfill), false));
                }
                if !core.unsure(&id) {
                    return AtHead::Skipped;
                }
            }
            AtHead::Pulled(core.sync_pass(id, Pull::Quiet).await)
        });
        self.env.noted(Noted::PullQueued);
        let at_head = tokio::select! {
            biased;
            () = linked.stop.cancelled() => return Tried::Stopped,
            at_head = pass => at_head.expect("a queued pass runs to its end, since a panic ends the program"),
        };
        match at_head {
            AtHead::Pulled(joined) => match self.ended(joined, linked).await {
                Some(ended) => Tried::Ended(ended),
                None => Tried::Stopped,
            },
            // Another pull did the work, or the link stopped, which the schedule sees as it waits next.
            AtHead::Skipped => Tried::Ended(Ok(())),
            AtHead::HintStale => Tried::HintStale,
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

    /// Tells every schedule the network may be back (`Request::NetworkBack`), and answers at once.
    /// Each decides for itself whether that changes its wait (see the module docs).
    pub(crate) fn network_back(self: &Rc<Self>, id: RequestId) {
        for linked in self.state.borrow().adapters.values() {
            linked.network.notify_waiters();
        }
        self.respond(id, Response::NetworkBack(Answer::from(Ok(Empty {}))));
    }

    /// True when a network-back hint, taken when the account's pulls had ended `ended` times,
    /// should pull it now: its last pull found the provider offline and none has ended since,
    /// its health still reads offline, and no pull or backfill page is queued or running for it
    /// but `own`, which a job at the head of the queue counts as itself. The schedule asks when
    /// the hint comes, when its settle ends, and at the head of the queue, as any of them can
    /// change meanwhile: a pull already under way may end, or a push may leave the health on
    /// needing a sign-in, or offline after a pull that went well.
    fn hint_holds(&self, account_id: &AccountId, ended: u64, own: usize) -> bool {
        let pulls = self.pulls_ended(account_id);
        let state = self.state.borrow();
        let offline = state
            .world
            .accounts
            .get(account_id)
            .is_some_and(|account| account.health == Health::Offline);
        let queued = state.pulls.get(account_id).copied().unwrap_or_default();
        pulls.offline && pulls.ended == ended && offline && queued <= own && !state.backfills.contains_key(account_id)
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
