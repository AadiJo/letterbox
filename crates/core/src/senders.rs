//! Updates: automated conversations grouped by sender, kept between commits like a thread
//! list (see live_view.rs). Each group holds its conversations in list order and running
//! sums of their messages, and the groups sit in order of their newest conversation. A
//! commit moves only the threads it changed in and out of their groups, so its cost follows
//! what it changed, not the size of the mailbox (budget.rs).
//!
//! Each group also sums its conversations' messages per UTC day, and the answer reads the
//! last DAYS of them on the core's clock. Time alone moves those days on at midnight, so the
//! view reads the time like a list that splits on age, and `wakes_at` books a wake for the
//! next midnight (see subscriptions.rs).

use std::cmp::Reverse;
use std::collections::{BTreeMap, BTreeSet};

use chrono::DateTime;
use letterbox_protocol::{SenderDay, SenderId, SenderPage, SenderSummary, ThreadFilter, Time};

use crate::clock::iso;
use crate::live_view::{Place, place};
use crate::maps::HashMap;
use crate::rows::{Listed, Refresh, Rows, day_of};
use crate::views::{Live, matches};
use crate::work::Meter;

/// How many days of volume a sender's row shows, today the last.
const DAYS: i64 = 14;

/// One sender's conversations.
#[derive(Debug, Default, PartialEq)]
struct Group {
    threads: BTreeSet<Place>,
    messages: u64,
    unread: u64,
    /// Their messages per UTC day (see `day_of`). A day with none has no entry.
    days: BTreeMap<i64, SenderDay>,
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
    /// How many groups have unread mail, and how many unread messages they hold in all.
    unread_senders: u64,
    unread: u64,
    /// The day the last answer ended on. When the clock moves past it, the answer changes.
    today: i64,
}

impl Senders {
    /// Groups every thread in the rows. Reads every row, so only a new view or a full refresh calls it.
    pub fn open(filter: ThreadFilter, offset: u64, limit: u64, rows: &Rows, live: &dyn Live, meter: &Meter) -> Senders {
        let mut senders = Senders {
            filter,
            offset,
            limit,
            groups: HashMap::default(),
            order: BTreeSet::new(),
            unread_senders: 0,
            unread: 0,
            today: day_of(&live.now()),
        };
        for listed in rows.all() {
            meter.matched();
            senders.add(listed);
        }
        senders
    }

    /// Moves the threads a refresh changed between groups. True when a group changed, or the
    /// clock moved on to another day.
    pub fn catch_up(&mut self, refresh: &Refresh, rows: &Rows, live: &dyn Live, meter: &Meter) -> bool {
        let changed = match refresh {
            Refresh::Everything => {
                let filter = std::mem::take(&mut self.filter);
                *self = Senders::open(filter, self.offset, self.limit, rows, live, meter);
                return true;
            }
            Refresh::Threads { changed, .. } => changed,
        };
        let today = day_of(&live.now());
        let mut moved = today != self.today;
        self.today = today;
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
            let fresh = Senders::open(
                self.filter.clone(),
                self.offset,
                self.limit,
                rows,
                live,
                &Meter::default(),
            );
            assert!(
                self.groups == fresh.groups
                    && self.order == fresh.order
                    && (self.unread_senders, self.unread) == (fresh.unread_senders, fresh.unread),
                "the senders kept between commits differ from senders grouped afresh from the rows"
            );
        }
        moved
    }

    /// When the days move on: the next UTC midnight.
    pub fn wakes_at(&self) -> Option<Time> {
        let midnight = DateTime::from_timestamp(self.today.checked_add(1)?.checked_mul(86_400)?, 0)?;
        Some(iso(midnight))
    }

    /// One window of the groups, newest first, each told by its newest conversation.
    pub fn answer(&self, rows: &Rows) -> SenderPage {
        let first = self.today - (DAYS - 1);
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
                days: (first..=self.today)
                    .map(|day| group.days.get(&day).copied().unwrap_or_default())
                    .collect(),
            })
        });
        SenderPage {
            total: self.order.len() as u64,
            unread_senders: self.unread_senders,
            unread: self.unread,
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
        let was_unread = group.unread;
        group.threads.insert(place(&listed.summary));
        group.messages += listed.summary.message_count;
        group.unread += listed.unread;
        for (day, counts) in &sender.days {
            let sum = group.days.entry(*day).or_default();
            sum.messages += counts.messages;
            sum.unread += counts.unread;
        }
        let unread = group.unread;
        self.count_unread(was_unread, unread);
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
        let was_unread = group.unread;
        group.messages -= listed.summary.message_count;
        group.unread -= listed.unread;
        for (day, counts) in &sender.days {
            if let Some(sum) = group.days.get_mut(day) {
                sum.messages -= counts.messages;
                sum.unread -= counts.unread;
                if sum.messages == 0 {
                    group.days.remove(day);
                }
            }
        }
        let unread = group.unread;
        self.count_unread(was_unread, unread);
        self.reorder(&sender.id, newest);
        true
    }

    /// Follows one group's unread messages from `was` to `now` in the sums over every group.
    fn count_unread(&mut self, was: u64, now: u64) {
        self.unread = self.unread - was + now;
        self.unread_senders = self.unread_senders - u64::from(was > 0) + u64::from(now > 0);
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
