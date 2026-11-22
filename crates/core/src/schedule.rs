//! The sync schedule. The core pulls from each signed-in account's provider on its own, so mail
//! comes in, and `your-turn` is told (notify.rs), while the app runs and nobody asks for a sync.
//!
//! Each linked account has one schedule, a task that waits on the clock (`Environment::idle`),
//! then queues a sync pass and waits again:
//!   - At start it pulls at once: a saved cursor makes the pull a change set of what came while
//!     the app was quit, which notify.rs's `CatchUp` keeps quiet. After a sign-in, whose own
//!     pass just pulled, it waits PERIOD first.
//!   - It pulls every PERIOD while pulls go well. Each failed pull in a row doubles the wait,
//!     up to MOST. After a pull that needs a sign-in it waits only for the health to clear: a
//!     new sign-in starts a schedule of its own, and this one ends.
//!   - An idle wait ends early when the wall clock jumps, as it does when the machine wakes from
//!     a suspend, so the pull comes then and not a period later.
//!   - When the account's health clears, because some other call reached the provider, the
//!     network is back: it pulls at once, through a wait of zero.
//!   - It starts no pass while another one that pulls is queued or running for the account
//!     (`enqueue_pull` in queue.rs), or a backfill's pages are queued: that pass pulls anyway.
//!     It waits PERIOD more instead.
//!
//! Every wait goes through the environment, so the harness's fixed clock holds each one until
//! the scenario moves the clock (see `FixedEnvironment::moved_by`). A schedule counts as work in
//! the core's TaskTracker, so `Core::close` waits for it to end, and close ends it where it waits
//! through `closing`: no pass starts after close begins, and an idle account holds nothing up.

use std::rc::Rc;
use std::time::Duration;

use letterbox_protocol::AccountId;

use crate::adapter::AdapterFailure;
use crate::sync::PassResult;
use crate::{Inner, Linked};

/// How long an account waits between pulls while they go well. A pull that finds nothing new
/// costs one cheap call (Gmail's `history.list`, 2 quota units of the 250 a user may spend
/// each second), so a minute keeps mail current to within a minute at a tiny share of the quota.
/// A rate limit is waited out inside the call (crates/gmail), and the pass stays running
/// meanwhile, so no pull piles up behind it.
pub(crate) const PERIOD: Duration = Duration::from_secs(60);

/// The longest wait between pulls that fail. Offline, a pull costs nothing at the provider, and
/// five minutes is as late as mail should come once the network is back with nothing else to
/// say so. A provider that keeps failing is asked no more than that.
const MOST: Duration = Duration::from_secs(300);

/// How a schedule's wait ended.
enum Woke {
    /// The time for the next pull came.
    Due,
    /// The account's health cleared: the provider can be reached again.
    Cleared,
    /// The core is closing.
    Closing,
}

impl Inner {
    /// Starts the schedule of the account `linked` serves, with its first pull after `first`.
    /// lib.rs starts one for each account it resumes at start, with zero, and accounts.rs one
    /// after a sign-in's first pass, with PERIOD.
    pub(crate) fn schedule(self: &Rc<Self>, account_id: AccountId, linked: Linked, first: Duration) {
        self.work
            .spawn_local(Rc::clone(self).run_schedule(account_id, linked, first));
    }

    /// The schedule's loop. It ends at close, or once `linked` no longer serves the account.
    async fn run_schedule(self: Rc<Self>, account_id: AccountId, linked: Linked, first: Duration) {
        let mut wait = Some(first);
        let mut failures = 0;
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
                () = self.closing.cancelled() => Woke::Closing,
                () = cleared => Woke::Cleared,
                () = due => Woke::Due,
            };
            if matches!(woke, Woke::Closing) || !self.still_current(&account_id, &linked) {
                return;
            }
            if matches!(woke, Woke::Cleared) {
                failures = 0;
                wait = Some(Duration::ZERO);
                continue;
            }
            let busy = self.state.borrow().pulls.contains_key(&account_id) || self.backfilling(&account_id);
            if busy {
                wait = Some(PERIOD);
                continue;
            }
            wait = match self.scheduled_pass(&account_id).await {
                None | Some(Ok(())) => {
                    failures = 0;
                    Some(PERIOD)
                }
                Some(Err(AdapterFailure::NeedsSignIn)) => None,
                Some(Err(_)) => {
                    failures += 1;
                    Some(PERIOD.saturating_mul(2_u32.saturating_pow(failures)).min(MOST))
                }
            };
        }
    }

    /// Queues one pass that pulls, and hands back how it ended.
    async fn scheduled_pass(self: &Rc<Self>, account_id: &AccountId) -> Option<PassResult> {
        let pass = self.enqueue_pull(account_id, Rc::clone(self).pass(account_id.clone(), true));
        pass.await
            .expect("a queued pass runs to its end, since a panic ends the program")
    }
}
