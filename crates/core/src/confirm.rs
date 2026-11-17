//! Confirming sends that may have reached the provider without the core hearing so (see
//! outbox.rs). Each such send has its own checks, and at most one is booked at a time
//! (`State::checks`), so the lookups in one round are one per unresolved send, however
//! many there are and however often a pass or a restart asks. A check is a job in the
//! account's queue that looks up only its own send:
//!
//!   - Found, the send is delivered.
//!   - Once its window has ended, it fails `unconfirmed`, whether the last lookup came back
//!     empty or failed. A failed lookup says nothing either way, and the window is over.
//!   - Else the next check is booked a step on, or at the end of the window.
//!
//! The waits are not work a closing core finishes. A restart books one check per send again.

use std::rc::Rc;

use chrono::TimeDelta;
use letterbox_protocol::{AccountId, ChangeId, ChangeResult, Refusal, Time};
use tokio::task::spawn_local;

use crate::Inner;
use crate::adapter::Found;
use crate::clock::{iso, parse};
use crate::effect::Effect;
use crate::outbox::{Outbound, Stage};
use crate::world::ChangeRecord;

/// How many more times an unconfirmed send is looked up after the first, spread across the window.
const MORE_LOOKUPS: u32 = 4;

impl Inner {
    /// Marks a send that may have reached the provider as unconfirmed, with the end of its
    /// confirm window, and books its first check.
    pub(crate) fn unconfirm(self: &Rc<Self>, record: ChangeRecord, outbound: &Outbound) {
        let account_id = record.account_id.clone();
        let until = self.confirm_until();
        let record = self.restage(record, outbound, Stage::Unconfirmed { until });
        self.book_check(&account_id, record.id, None);
    }

    /// When a confirm window that starts now ends.
    fn confirm_until(&self) -> Time {
        let window = TimeDelta::from_std(self.confirm_window).unwrap_or(TimeDelta::MAX);
        let now = parse(&self.env.now());
        iso(now.checked_add_signed(window).unwrap_or(now))
    }

    /// Books the send's next check, at `at`, or at once. Does nothing when one is booked already.
    pub(crate) fn book_check(self: &Rc<Self>, account_id: &AccountId, change: ChangeId, at: Option<Time>) {
        if !self.state.borrow_mut().checks.insert(change.clone()) {
            return;
        }
        let account_id = account_id.clone();
        let Some(at) = at else {
            return self.background(&account_id.clone(), Rc::clone(self).check(account_id, change));
        };
        let wait = self.env.until(&at);
        let core = Rc::clone(self);
        spawn_local(async move {
            wait.await;
            if !core.work.is_closed() {
                core.background(&account_id.clone(), Rc::clone(&core).check(account_id, change));
            }
        });
    }

    /// One check of one send: looks it up and settles it, or books the next check.
    async fn check(self: Rc<Self>, account_id: AccountId, change: ChangeId) {
        let found = {
            let mut state = self.state.borrow_mut();
            state.checks.remove(&change);
            let record = state
                .world
                .changes
                .get(&change)
                .filter(|record| record.outcome.is_none());
            let linked = state.adapters.get(&account_id).cloned();
            record.cloned().zip(linked)
        };
        // Settled meanwhile, or signed out: a later pass books a check again if it is needed.
        let Some((record, linked)) = found else { return };
        let Effect::Send(outbound) = record.effect.clone() else {
            return;
        };
        let (record, until) = match outbound.stage.clone() {
            // The core stopped during the call, so the provider may hold it.
            Stage::Sending => {
                let until = self.confirm_until();
                let stage = Stage::Unconfirmed { until: until.clone() };
                (self.restage(record, &outbound, stage), until)
            }
            Stage::Unconfirmed { until } => (record, until),
            Stage::Held { .. } | Stage::Due => return,
        };
        let found = linked.adapter.find(outbound.header_id.clone()).await;
        if !self.still_current(&account_id, &linked) {
            return;
        }
        // The account's status shows what the provider said, as after a sync pass.
        let reached = found.as_ref().map(drop).map_err(|failure| *failure);
        self.record_outcome(&account_id, reached, false, false);
        let now = parse(&self.env.now());
        match found {
            Ok(Found { r#ref: Some(r#ref) }) => self.delivered(&account_id, record, &outbound, r#ref),
            _ if now >= parse(&until) => self.settle(record, ChangeResult::Failed(Refusal::Unconfirmed)),
            _ => {
                let step = TimeDelta::from_std(self.confirm_window / MORE_LOOKUPS).unwrap_or(TimeDelta::MAX);
                let next = now.checked_add_signed(step).unwrap_or(now).min(parse(&until));
                self.book_check(&account_id, record.id, Some(iso(next)));
            }
        }
    }
}
