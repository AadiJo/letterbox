//! Updates: automated conversations grouped by sender, kept between commits like a thread
//! list (see live_view.rs). Each group holds its conversations in list order and running
//! sums of their messages, and the groups sit in order of their newest conversation. A
//! commit moves only the threads it changed in and out of their groups, so its cost follows
//! what it changed, not the size of the mailbox (budget.rs).

use std::cmp::Reverse;
use std::collections::BTreeSet;

use letterbox_protocol::{SenderId, SenderPage, SenderSummary, ThreadFilter, Time};

use crate::live_view::{Place, place};
use crate::maps::HashMap;
use crate::rows::{Listed, Refresh, Rows};
use crate::views::matches;
use crate::work::Meter;

/// One sender's conversations.
#[derive(Debug, Default, PartialEq)]
struct Group {
    threads: BTreeSet<Place>,
    messages: u64,
    unread: u64,
}

/// The view behind a senders subscription.
pub struct Senders {
    /// The account and mailbox Updates covers. A thread in a group passes it and has a sender.
    filter: ThreadFilter,
    offset: u64,
    limit: u64,
    groups: HashMap<SenderId, Group>,
    /// Every group, by its newest conversation: newest first.
    order: BTreeSet<(Reverse<Time>, SenderId)>,
}

impl Senders {
    /// Groups every thread in the rows. Reads every row, so only a new view or a full refresh calls it.
    pub fn open(filter: ThreadFilter, offset: u64, limit: u64, rows: &Rows, meter: &Meter) -> Senders {
        let mut senders = Senders {
            filter,
            offset,
            limit,
            groups: HashMap::default(),
            order: BTreeSet::new(),
        };
        for listed in rows.all() {
            meter.matched();
            senders.add(listed);
        }
        senders
    }

    /// Moves the threads a refresh changed between groups. True when a group changed.
    pub fn catch_up(&mut self, refresh: &Refresh, rows: &Rows, meter: &Meter) -> bool {
        let changed = match refresh {
            Refresh::Everything => {
                let filter = std::mem::take(&mut self.filter);
                *self = Senders::open(filter, self.offset, self.limit, rows, meter);
                return true;
            }
            Refresh::Threads { changed, .. } => changed,
        };
        let mut moved = false;
        for one in changed {
            if let Some(before) = &one.before {
                moved |= self.remove(before);
            }
            if let Some(after) = rows.listed(&one.id) {
                meter.matched();
                moved |= self.add(after);
            }
        }
        if cfg!(test) {
            let fresh = Senders::open(self.filter.clone(), self.offset, self.limit, rows, &Meter::default());
            assert!(
                self.groups == fresh.groups && self.order == fresh.order,
                "the senders kept between commits differ from senders grouped afresh from the rows"
            );
        }
        moved
    }

    /// One window of the groups, newest first, each told by its newest conversation.
    pub fn answer(&self, rows: &Rows) -> SenderPage {
        let skip = usize::try_from(self.offset).unwrap_or(usize::MAX);
        let take = usize::try_from(self.limit).unwrap_or(usize::MAX);
        let senders = self.order.iter().skip(skip).take(take).filter_map(|(_, id)| {
            let group = self.groups.get(id)?;
            let (_, newest) = group.threads.first()?;
            let listed = rows.listed(newest)?;
            let sender = listed.sender.as_ref()?;
            Some(SenderSummary {
                id: id.clone(),
                account_id: listed.summary.account_id.clone(),
                name: sender.name.clone(),
                address: sender.address.clone(),
                threads: group.threads.len() as u64,
                messages: group.messages,
                unread: group.unread,
                subject: listed.summary.subject.clone(),
                last_message_at: listed.summary.last_message_at.clone(),
            })
        });
        SenderPage {
            total: self.order.len() as u64,
            senders: senders.collect(),
        }
    }

    /// Puts a thread in its sender's group, if it belongs in Updates. True when it does.
    fn add(&mut self, listed: &Listed) -> bool {
        let Some(sender) = listed.sender.as_ref().filter(|_| matches(listed, &self.filter)) else {
            return false;
        };
        let group = self.groups.entry(sender.id.clone()).or_default();
        let newest = group.threads.first().cloned();
        group.threads.insert(place(&listed.summary));
        group.messages += listed.summary.message_count;
        group.unread += listed.unread;
        self.reorder(&sender.id, newest);
        true
    }

    /// Takes a thread, as it was, out of its sender's group. True when it was in one.
    fn remove(&mut self, listed: &Listed) -> bool {
        let Some(sender) = &listed.sender else {
            return false;
        };
        let Some(group) = self.groups.get_mut(&sender.id) else {
            return false;
        };
        let newest = group.threads.first().cloned();
        if !group.threads.remove(&place(&listed.summary)) {
            return false;
        }
        group.messages -= listed.summary.message_count;
        group.unread -= listed.unread;
        self.reorder(&sender.id, newest);
        true
    }

    /// Re-sorts a group whose newest conversation was `was`, and drops it once it is empty.
    fn reorder(&mut self, id: &SenderId, was: Option<Place>) {
        if let Some((time, _)) = was {
            self.order.remove(&(time, id.clone()));
        }
        match self.groups.get(id).and_then(|group| group.threads.first()) {
            Some((time, _)) => {
                self.order.insert((time.clone(), id.clone()));
            }
            None => {
                self.groups.remove(id);
            }
        }
    }
}
