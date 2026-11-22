//! Updates: automated conversations grouped by sender, kept between commits like a thread
//! list (see live_view.rs). Each group holds its conversations in list order and running
//! sums of their messages, and the groups sit in order of their newest conversation. A
//! commit moves only the threads it changed in and out of their groups, so its cost follows
//! what it changed, not the size of the mailbox (budget.rs).
//!
//! Each group also keeps when its conversations' messages were sent, and the answer counts
//! them by the user's last DAYS days, in the zone the query names, on the core's clock. Time
//! alone moves those days on at the zone's midnight, so the view reads the time like a list
//! that splits on age, and `wakes_at` books a wake for the next midnight (see subscriptions.rs).

use std::cmp::Reverse;
use std::collections::{BTreeMap, BTreeSet};

use chrono::{Days, NaiveDate, NaiveTime, TimeDelta, TimeZone};
use chrono_tz::Tz;
use letterbox_protocol::{SenderDay, SenderId, SenderPage, SenderSummary, ThreadFilter, Time};

use crate::clock::{iso, parse};
use crate::live_view::{Place, place};
use crate::maps::HashMap;
use crate::rows::{Listed, Refresh, Rows};
use crate::views::{Live, matches};
use crate::work::Meter;

/// How many days of volume a sender's row shows, today the last.
const DAYS: u64 = 14;

/// The zone a query names, or UTC for none or one the zone database does not know.
pub fn zone_of(name: Option<&str>) -> Tz {
    name.and_then(|name| name.parse().ok()).unwrap_or(Tz::UTC)
}

/// The day `now` falls on in `zone`.
fn day_of(zone: Tz, now: &Time) -> NaiveDate {
    parse(now).with_timezone(&zone).date_naive()
}

/// When `day` starts in `zone`, in seconds since the epoch: its midnight, or, on a day whose
/// midnight a clock change skips, the first moment it has. A day a zone skipped whole (as
/// Samoa skipped Dec 30, 2011) starts when the next one does, and so holds nothing.
fn start_of(zone: Tz, day: NaiveDate) -> i64 {
    let midnight = day.and_time(NaiveTime::MIN);
    (0..=24)
        .find_map(|hour| {
            zone.from_local_datetime(&(midnight + TimeDelta::hours(hour)))
                .earliest()
        })
        .map_or_else(
            || day.succ_opt().map_or(i64::MAX, |next| start_of(zone, next)),
            |at| at.timestamp(),
        )
}

/// One sender's conversations.
#[derive(Debug, Default, PartialEq)]
struct Group {
    threads: BTreeSet<Place>,
    messages: u64,
    unread: u64,
    /// Their messages by the second they were sent (rows.rs `Sender::sent`), with how many
    /// are unread. A second with none has no entry.
    sent: BTreeMap<i64, SenderDay>,
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
    /// The user's zone, whose days the answer counts by.
    zone: Tz,
    /// The day the last answer ended on. When the clock moves past it, the answer changes.
    today: NaiveDate,
}

impl Senders {
    /// Groups every thread in the rows. Reads every row, so only a new view or a full refresh calls it.
    pub fn open(
        filter: ThreadFilter,
        zone: Tz,
        (offset, limit): (u64, u64),
        rows: &Rows,
        live: &dyn Live,
        meter: &Meter,
    ) -> Senders {
        let mut senders = Senders {
            filter,
            offset,
            limit,
            groups: HashMap::default(),
            order: BTreeSet::new(),
            unread_senders: 0,
            unread: 0,
            zone,
            today: day_of(zone, &live.now()),
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
                *self = Senders::open(filter, self.zone, (self.offset, self.limit), rows, live, meter);
                return true;
            }
            Refresh::Threads { changed, .. } => changed,
        };
        let today = day_of(self.zone, &live.now());
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
            let window = (self.offset, self.limit);
            let fresh = Senders::open(self.filter.clone(), self.zone, window, rows, live, &Meter::default());
            assert!(
                self.groups == fresh.groups
                    && self.order == fresh.order
                    && (self.unread_senders, self.unread) == (fresh.unread_senders, fresh.unread),
                "the senders kept between commits differ from senders grouped afresh from the rows"
            );
        }
        moved
    }

    /// When the days move on: the next midnight in the user's zone.
    pub fn wakes_at(&self) -> Option<Time> {
        let start = start_of(self.zone, self.today.succ_opt()?);
        Some(iso(chrono::DateTime::from_timestamp(start, 0)?))
    }

    /// One window of the groups, newest first, each told by its newest conversation.
    pub fn answer(&self, rows: &Rows) -> SenderPage {
        // Where each of the last DAYS days starts, then where tomorrow does.
        let first = self.today.checked_sub_days(Days::new(DAYS - 1)).unwrap_or(self.today);
        let starts: Vec<i64> = first
            .iter_days()
            .take(usize::try_from(DAYS + 1).unwrap_or(usize::MAX))
            .map(|day| start_of(self.zone, day))
            .collect();
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
                days: starts
                    .windows(2)
                    .map(|day| {
                        let (from, to) = (day[0], day[1]);
                        group
                            .sent
                            .range(from..to)
                            .fold(SenderDay::default(), |sum, (_, one)| SenderDay {
                                messages: sum.messages + one.messages,
                                unread: sum.unread + one.unread,
                            })
                    })
                    .collect(),
                unsubscribe: sender.unsubscribe.clone(),
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
        for (at, unread) in &sender.sent {
            let sum = group.sent.entry(*at).or_default();
            sum.messages += 1;
            sum.unread += u64::from(*unread);
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
        for (at, unread) in &sender.sent {
            if let Some(sum) = group.sent.get_mut(at) {
                sum.messages -= 1;
                sum.unread -= u64::from(*unread);
                if sum.messages == 0 {
                    group.sent.remove(at);
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
