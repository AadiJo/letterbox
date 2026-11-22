//! Every thread's row and every mailbox's counts, kept between commits. Each commit marks
//! the threads it touched (see `Touched` in world.rs), and `refresh` rebuilds only those,
//! so no view reads every thread to answer.
//!
//! In the core's tests every refresh also checks the kept rows against rows built afresh
//! (see budget.rs), so a change to the world that marks too little fails a check instead of
//! showing stale rows. Only tests check: the scenarios' transcripts depend on how fast the
//! core answers, and a full rebuild per commit slows it enough to change them.

use std::borrow::Cow;

use letterbox_protocol::{AccountId, MailboxId, Person, SenderId, ThreadId, ThreadSummary};

use crate::changes::Pending;
use crate::clock::parse;
use crate::maps::{HashMap, IndexMap, IndexSet};
use crate::turns::{TurnMessage, decide_turn, held_override, is_automated};
use crate::views::{person, same};
use crate::work::Meter;
use crate::world::{MessageRecord, MessageState, Touched, World, messages_of};

/// How many messages a mailbox holds, as the user sees them, and how many of those are unread.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Counts {
    pub total: u64,
    pub unread: u64,
}

/// What the lists read of one thread: its row, and what Updates groups it by.
#[derive(Clone, Debug, PartialEq)]
pub struct Listed {
    pub summary: ThreadSummary,
    /// The sender Updates groups it under, or None when it is not automated (see `sender_of`).
    pub sender: Option<Sender>,
    /// How many of its messages are unread, as the user sees them.
    pub unread: u64,
}

/// Who sent an automated conversation: the address of its newest message from someone else.
#[derive(Clone, Debug, PartialEq)]
pub struct Sender {
    /// The same for every address that differs only in case, within one account.
    pub id: SenderId,
    pub name: Option<String>,
    pub address: String,
    /// When each of the conversation's messages was sent, in seconds since the epoch, and
    /// whether it is unread, oldest first. Updates sums them per sender and counts them by the
    /// user's days for its volume strip (senders.rs).
    pub sent: Vec<(i64, bool)>,
}

/// What one thread adds to the views.
#[derive(Debug, Default, PartialEq)]
struct Row {
    /// None when the thread has no row (see `summarize`). Its messages still count in their mailboxes.
    listed: Option<Listed>,
    /// What its messages add to each mailbox's counts.
    counts: Vec<(MailboxId, Counts)>,
}

/// A thread whose row changed in a refresh, and its row before.
pub struct Changed {
    pub id: ThreadId,
    pub before: Option<Listed>,
}

/// What a refresh rebuilt.
pub enum Refresh {
    /// Every row, because something every row reads changed. Every view answers again.
    Everything,
    /// The rows of the threads a commit touched. `changed` lists the ones whose row is different now.
    Threads {
        touched: IndexSet<ThreadId>,
        changed: Vec<Changed>,
    },
}

#[derive(Default)]
pub struct Rows {
    rows: HashMap<ThreadId, Row>,
    /// The sum of every row's counts. A mailbox no message is in has no entry.
    counts: HashMap<MailboxId, Counts>,
}

impl Rows {
    /// Rebuilds the rows of what changed since the last refresh. Call it before reading
    /// rows after any change to the world.
    pub fn refresh(&mut self, world: &World, touched: Touched, meter: &Meter) -> Refresh {
        if touched.everything {
            *self = Rows::build(world, meter);
            return Refresh::Everything;
        }
        let mut changed = Vec::new();
        if !touched.threads.is_empty() {
            let pending = Pending::of(world);
            for id in &touched.threads {
                let row = row(world, id, &pending, meter);
                let before = self.rows.remove(id).unwrap_or_default();
                self.add(&before.counts, Counts::minus);
                self.add(&row.counts, Counts::plus);
                if row.listed != before.listed {
                    changed.push(Changed {
                        id: id.clone(),
                        before: before.listed,
                    });
                }
                if row.listed.is_some() || !row.counts.is_empty() {
                    self.rows.insert(id.clone(), row);
                }
            }
        }
        if cfg!(test) {
            self.check(world);
        }
        Refresh::Threads {
            touched: touched.threads,
            changed,
        }
    }

    pub fn summary(&self, id: &ThreadId) -> Option<&ThreadSummary> {
        Some(&self.listed(id)?.summary)
    }

    pub fn listed(&self, id: &ThreadId) -> Option<&Listed> {
        self.rows.get(id)?.listed.as_ref()
    }

    /// Every thread that has a row, in no particular order.
    pub fn all(&self) -> impl Iterator<Item = &Listed> {
        self.rows.values().filter_map(|row| row.listed.as_ref())
    }

    pub fn counts(&self, mailbox: &MailboxId) -> Counts {
        self.counts.get(mailbox).copied().unwrap_or_default()
    }

    /// Every row, built from the world as it is now.
    fn build(world: &World, meter: &Meter) -> Rows {
        let pending = Pending::of(world);
        let ids: IndexSet<&ThreadId> = world.threads.keys().chain(world.messages_by_thread.keys()).collect();
        let mut rows = Rows::default();
        for id in ids {
            let row = row(world, id, &pending, meter);
            rows.add(&row.counts, Counts::plus);
            rows.rows.insert(id.clone(), row);
        }
        rows.rows
            .retain(|_, row| row.listed.is_some() || !row.counts.is_empty());
        rows
    }

    fn add(&mut self, counts: &[(MailboxId, Counts)], apply: fn(Counts, Counts) -> Counts) {
        for (mailbox, count) in counts {
            let total = apply(self.counts(mailbox), *count);
            if total == Counts::default() {
                self.counts.remove(mailbox);
            } else {
                self.counts.insert(mailbox.clone(), total);
            }
        }
    }

    /// Panics when the kept rows differ from rows built afresh.
    fn check(&self, world: &World) {
        let fresh = Rows::build(world, &Meter::default());
        assert!(
            self.rows == fresh.rows && self.counts == fresh.counts,
            "the rows kept between commits differ from rows built afresh, so a change to the world \
             did not mark every thread it affects. Mark them in `Touched` from the put_ or remove_ \
             function in world.rs that made the change."
        );
    }
}

impl Counts {
    fn plus(self, other: Counts) -> Counts {
        Counts {
            total: self.total + other.total,
            unread: self.unread + other.unread,
        }
    }

    fn minus(self, other: Counts) -> Counts {
        Counts {
            total: self.total - other.total,
            unread: self.unread - other.unread,
        }
    }
}

/// The row of one thread, from its messages as the user sees them.
fn row<'a>(world: &'a World, id: &ThreadId, pending: &Pending<'a>, meter: &Meter) -> Row {
    meter.summarized();
    let records = messages_of(world, id);
    let states: Vec<Cow<'a, MessageState>> = records.iter().map(|record| pending.view_state(record)).collect();
    let mut counts: Vec<(MailboxId, Counts)> = Vec::new();
    for state in &states {
        let one = Counts {
            total: 1,
            unread: u64::from(state.unread),
        };
        for mailbox in &state.mailboxes {
            match counts.iter_mut().find(|(id, _)| id == mailbox) {
                Some((_, count)) => *count = count.plus(one),
                None => counts.push((mailbox.clone(), one)),
            }
        }
    }
    let listed = summarize(world, id, &records, &states, pending).map(|summary| Listed {
        sender: sender_of(world, &summary.account_id, &records, &states),
        unread: states.iter().filter(|state| state.unread).count() as u64,
        summary,
    });
    Row { listed, counts }
}

/// The sender Updates groups a conversation under: the address of its newest message from
/// someone else, when a machine sent that message (see `is_automated`). None for a conversation
/// a person wrote last to me, or one with no message from anyone else. The address, not its
/// domain, is the sender: one company's news@ and no-reply@ often carry unrelated mail.
fn sender_of(
    world: &World,
    account_id: &AccountId,
    records: &[&MessageRecord],
    states: &[Cow<'_, MessageState>],
) -> Option<Sender> {
    let me = &world.accounts.get(account_id)?.address;
    let newest = records
        .iter()
        .rev()
        .find(|record| !same(&record.facts.from.address, me))?;
    if !is_automated(&newest.facts) {
        return None;
    }
    let from = &newest.facts.from;
    #[expect(clippy::disallowed_methods, reason = "the one place sender ids are made")]
    let id = SenderId::minted(format!("sender_{account_id}_{}", from.address.to_lowercase()));
    let mut sent: Vec<(i64, bool)> = records
        .iter()
        .zip(states)
        .map(|(record, state)| (parse(&record.facts.sent_at).timestamp(), state.unread))
        .collect();
    sent.sort_unstable();
    Some(Sender {
        id,
        name: from.name.clone(),
        address: from.address.clone(),
        sent,
    })
}

/// One row for a thread, or None when the thread or its account is gone, or it has no messages left.
/// Its people are everyone taking part: each message's sender, then its to and cc recipients,
/// once per address (compared without case), in the order they first appear.
fn summarize(
    world: &World,
    thread_id: &ThreadId,
    records: &[&MessageRecord],
    states: &[Cow<'_, MessageState>],
    pending: &Pending<'_>,
) -> Option<ThreadSummary> {
    let thread = world.threads.get(thread_id)?;
    let account = world.accounts.get(&thread.account_id)?;
    let (first, last) = (records.first()?, records.last()?);

    let everyone = records.iter().flat_map(|record| {
        std::iter::once(&record.facts.from)
            .chain(&record.facts.to)
            .chain(&record.facts.cc)
    });
    let mut people: IndexMap<String, Person> = IndexMap::default();
    for address in everyone {
        people
            .entry(address.address.to_lowercase())
            .or_insert_with(|| person(address, &account.address));
    }
    // Only mail the provider holds moves the turn. A send still in the outbox, or one that
    // failed, may never reach anyone, so the turn stays where it was (see outbox.rs). The
    // same mail decides whether a turn the user set still holds.
    let held: Vec<&&MessageRecord> = records
        .iter()
        .filter(|record| record.provider_ref().is_some())
        .collect();
    let newest = held.last().map(|record| &record.facts.sent_at);
    let turn = decide_turn(
        &held
            .iter()
            .map(|record| TurnMessage {
                from_me: same(&record.facts.from.address, &account.address),
                to_me: record.facts.to.iter().any(|to| same(&to.address, &account.address)),
                to_addresses: record.facts.to.iter().map(|to| to.address.clone()).collect(),
                automated: is_automated(&record.facts),
            })
            .collect::<Vec<_>>(),
        held_override(thread, newest),
    );
    let mailbox_ids: IndexSet<&MailboxId> = states.iter().flat_map(|state| &state.mailboxes).collect();
    Some(ThreadSummary {
        id: thread.id.clone(),
        account_id: account.id.clone(),
        subject: first.facts.subject.clone(),
        people: people.into_values().collect(),
        snippet: last.facts.preview.clone(),
        last_message_at: last.facts.sent_at.clone(),
        message_count: records.len() as u64,
        unread: states.iter().any(|state| state.unread),
        flagged: states.iter().any(|state| state.flagged),
        has_attachments: records.iter().any(|record| record.facts.has_attachments),
        mailbox_ids: mailbox_ids
            .into_iter()
            .filter(|id| world.mailboxes.contains_key(*id))
            .cloned()
            .collect(),
        turn,
        pending: records.iter().any(|record| pending.touches(&record.id)),
    })
}
