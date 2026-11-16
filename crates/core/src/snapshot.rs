//! The snapshot, one page at a time. Each page is stored in its own commit and the
//! progress is saved with it, so a failure or a restart resumes from the next page.
//! Pages list the newest mail first (adapter rule 9), so recent mail shows while the
//! rest backfills.
//!
//! Every page after the first is its own job in the account's queue, queued when the
//! page before it ends. A change the user makes during a backfill is queued ahead of the
//! next page, so it reaches the provider between pages. One account has at most one
//! page job queued at a time: its backfill.

use std::rc::Rc;

use letterbox_protocol::AccountId;
use tokio::sync::oneshot;

use crate::adapter::AdapterFailure;
use crate::reconcile::{Incoming, reconcile, remove_unlisted};
use crate::sync::PassResult;
use crate::world::{AccountRecord, SnapshotProgress, put_account};
use crate::{Inner, Linked};

/// How a pull ended.
pub(crate) enum Pulled {
    /// The core is in step with the provider: a change set, or a snapshot's last page.
    Done,
    /// A snapshot page is stored and the next one is queued.
    More,
}

/// The backfill of one account: its next page job is queued. Kept in memory only.
#[derive(Default)]
pub(crate) struct Backfill {
    /// Told how the backfill ended. A sync-now waits here for the pages queued after its pass.
    waiting: Vec<oneshot::Sender<PassResult>>,
}

impl Inner {
    /// Lists one snapshot page and stores it, then queues the next page. Starts a new
    /// snapshot when none is under way. Pending changes still lay over what a page
    /// reports, since reconcile writes only the provider's side of each message.
    pub(crate) async fn snapshot_page(
        self: &Rc<Self>,
        account_id: &AccountId,
        linked: &Linked,
    ) -> Result<Pulled, AdapterFailure> {
        let started = {
            let state = self.state.borrow();
            state
                .world
                .accounts
                .get(account_id)
                .map(|account| match &account.snapshot {
                    Some(progress) => (account.round, progress.clone()),
                    None => (account.round + 1, SnapshotProgress::default()),
                })
        };
        let Some((round, progress)) = started else {
            return Ok(Pulled::Done);
        };
        let answer = linked.adapter.snapshot(progress.next.clone()).await;
        if !self.still_current(account_id, linked) {
            return Ok(Pulled::Done);
        }
        let page = match answer {
            // Rule 8. A new round lists the mailbox again, so what the dead one listed counts for nothing.
            Err(AdapterFailure::PageExpired) if progress.next.is_some() => {
                self.commit(|world, tx, _| {
                    let Some(account) = world.accounts.get(account_id).cloned() else {
                        return;
                    };
                    let snapshot = Some(SnapshotProgress::default());
                    put_account(
                        world,
                        tx,
                        AccountRecord {
                            round: round + 1,
                            snapshot,
                            ..account
                        },
                    );
                });
                self.queue_next_page(account_id);
                return Ok(Pulled::More);
            }
            answer => answer?,
        };

        let last = page.next.is_none();
        let listed =
            progress.listed + u64::try_from(page.messages.len()).expect("a page holds fewer than 2^64 messages");
        self.commit(|world, tx, _| {
            let Some(account) = world.accounts.get(account_id).cloned() else {
                return;
            };
            let incoming = Incoming {
                page_of: Some(round),
                mailboxes: Some(page.mailboxes),
                added: page.messages,
                updated: Vec::new(),
                removed: Vec::new(),
            };
            reconcile(world, tx, account_id, incoming);
            if last {
                remove_unlisted(world, tx, account_id, round);
            }
            // The cursor comes with the last page only. Until then the saved page resumes the snapshot.
            let progressed = match page.next {
                Some(next) => AccountRecord {
                    round,
                    snapshot: Some(SnapshotProgress {
                        next: Some(next),
                        listed,
                    }),
                    ..account
                },
                None => AccountRecord {
                    round,
                    snapshot: None,
                    cursor: page.cursor,
                    ..account
                },
            };
            put_account(world, tx, progressed);
        });
        if last {
            return Ok(Pulled::Done);
        }
        self.queue_next_page(account_id);
        Ok(Pulled::More)
    }

    /// Queues the job for the account's next page, behind whatever is queued now. A closing
    /// core queues no more: the saved progress resumes the snapshot on the next start's first pass.
    fn queue_next_page(self: &Rc<Self>, account_id: &AccountId) {
        if self.work.is_closed() {
            return;
        }
        self.state
            .borrow_mut()
            .backfills
            .insert(account_id.clone(), Backfill::default());
        self.background(account_id, Rc::clone(self).next_page(account_id.clone()));
    }

    /// One page of a backfill, as its own queue job. It runs as a pass, so it records how
    /// the sync went. Whoever waits for the backfill moves on to the next page's job, or
    /// is told how it ended.
    async fn next_page(self: Rc<Self>, account_id: AccountId) {
        let backfill = self.state.borrow_mut().backfills.remove(&account_id);
        let waiting = backfill.map(|backfill| backfill.waiting).unwrap_or_default();
        let ran = Rc::clone(&self).pass(account_id.clone(), true).await;
        if let Some(next) = self.state.borrow_mut().backfills.get_mut(&account_id) {
            next.waiting.extend(waiting);
            return;
        }
        let result = ran.unwrap_or(Ok(()));
        for sender in waiting {
            // A sync-now that stopped waiting is fine.
            let _ = sender.send(result);
        }
    }

    /// True while a page job is queued for the account. A pass then leaves the pulling to it.
    pub(crate) fn backfilling(&self, account_id: &AccountId) -> bool {
        self.state.borrow().backfills.contains_key(account_id)
    }

    /// Waits for the account's backfill to end, if one is under way. Call it from inside a
    /// queue job, so the backfill cannot end between the check and the wait.
    pub(crate) fn join_backfill(&self, account_id: &AccountId) -> Option<oneshot::Receiver<PassResult>> {
        let mut state = self.state.borrow_mut();
        let backfill = state.backfills.get_mut(account_id)?;
        let (sender, receiver) = oneshot::channel();
        backfill.waiting.push(sender);
        Some(receiver)
    }
}
