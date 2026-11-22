//! The per-account job queues. Work for one account runs in its queue, one job at a
//! time, so changes reach the provider in the order the user made them. Every job
//! counts as work in the core's TaskTracker until it ends, so `Core::close` waits for it.

use std::future::Future;
use std::rc::Rc;

use letterbox_protocol::AccountId;
use tokio::sync::{mpsc, oneshot};
use tokio::task::spawn_local;

use crate::Inner;
use crate::adapter::LocalFuture;

/// One queued task for an account.
pub(crate) type Job = LocalFuture<'static, ()>;

/// One pull counted in `pulls` (see `Inner::pulling`). Dropping it ends the count.
pub(crate) struct Pulling {
    core: Rc<Inner>,
    account_id: AccountId,
}

impl Drop for Pulling {
    fn drop(&mut self) {
        let mut state = self.core.state.borrow_mut();
        if let Some(count) = state.pulls.get_mut(&self.account_id) {
            *count -= 1;
            if *count == 0 {
                state.pulls.remove(&self.account_id);
            }
        }
    }
}

impl Inner {
    /// Runs `task` after everything already queued for this account, and hands back its result.
    pub(crate) fn enqueue<T: 'static>(
        self: &Rc<Self>,
        account_id: &AccountId,
        task: impl Future<Output = T> + 'static,
    ) -> oneshot::Receiver<T> {
        let (sender, receiver) = oneshot::channel();
        // Counts as work from now, not from when the job starts, so the core never looks idle
        // between one job ending and the next one starting.
        let in_flight = self.work.token();
        let job: Job = Box::pin(async move {
            // Nobody waits for a background task's result, so a closed receiver is expected.
            let _ = sender.send(task.await);
            drop(in_flight);
        });
        let mut queues = self.queues.borrow_mut();
        let queue = queues.entry(account_id.clone()).or_insert_with(|| self.start_queue());
        assert!(queue.send(job).is_ok(), "a queue's task lives as long as the core");
        receiver
    }

    /// Queues a pass that pulls, and counts it as pulling from now until it ends (`pulling`).
    /// Every pull job goes through here: a sign-in's, a sync-now's, a backfill page's and the schedule's.
    pub(crate) fn enqueue_pull<T: 'static>(
        self: &Rc<Self>,
        account_id: &AccountId,
        task: impl Future<Output = T> + 'static,
    ) -> oneshot::Receiver<T> {
        let pulling = self.pulling(account_id);
        self.enqueue(account_id, async move {
            let ended = task.await;
            drop(pulling);
            ended
        })
    }

    /// Counts the account as pulling in `pulls` until the returned guard drops, so the schedule
    /// starts no pull beside a pull that is queued or running (schedule.rs).
    pub(crate) fn pulling(self: &Rc<Self>, account_id: &AccountId) -> Pulling {
        *self.state.borrow_mut().pulls.entry(account_id.clone()).or_default() += 1;
        Pulling {
            core: Rc::clone(self),
            account_id: account_id.clone(),
        }
    }

    /// Queues a task nobody waits for.
    pub(crate) fn background<T: 'static>(
        self: &Rc<Self>,
        account_id: &AccountId,
        task: impl Future<Output = T> + 'static,
    ) {
        drop(self.enqueue(account_id, task));
    }

    /// Starts the task that runs one account's jobs in order.
    /// The task holds only the receiver, so it ends when the core drops its sender.
    fn start_queue(&self) -> mpsc::UnboundedSender<Job> {
        let (sender, mut jobs) = mpsc::unbounded_channel::<Job>();
        spawn_local(async move {
            while let Some(job) = jobs.recv().await {
                job.await;
            }
        });
        sender
    }
}
