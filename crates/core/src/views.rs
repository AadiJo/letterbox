//! Builds the answers to the live views a client subscribes to, from the world and the
//! rows kept between commits (see rows.rs). Everything here is a pure read.

use letterbox_protocol::{
    Account, AccountId, AccountStatus, Attachment, Body, Mailbox, Message, Person, ShowImages, SignInOption,
    ThreadDetail, ThreadFilter, ThreadId, ThreadPage, Time, Unavailable,
};

use crate::adapter::{BodyResult, RemoteAddress};
use crate::body;
use crate::changes::Pending;
use crate::outbox::delivery;
use crate::rows::{Listed, Rows};
use crate::world::{AccountRecord, MessageRecord, World, blob_id_of, messages_of, scoped};

/// The parts of an answer that live outside the world: what is in flight right now.
pub trait Live {
    fn status(&self, account: &AccountRecord) -> AccountStatus;
    /// The body state for a message whose body is not stored yet.
    fn missing_body(&self, record: &MessageRecord) -> Body;
    fn options(&self) -> &[SignInOption];
    /// The time a list that splits on age goes by (see live_view.rs). It is read from the clock
    /// only when such a list opens and when a wake runs (see subscriptions.rs).
    fn now(&self) -> Time;
}

pub fn same(a: &str, b: &str) -> bool {
    a.to_lowercase() == b.to_lowercase()
}

pub fn person(address: &RemoteAddress, me: &str) -> Person {
    Person {
        name: address.name.clone(),
        address: address.address.clone(),
        is_me: same(&address.address, me),
    }
}

/// True when a thread's row passes a list's filter. `retired` reads the clock, so the
/// list applies it to the threads that pass here (see `window` in live_view.rs).
pub fn matches(listed: &Listed, filter: &ThreadFilter) -> bool {
    let summary = &listed.summary;
    if filter.account_id.as_ref().is_some_and(|id| summary.account_id != *id) {
        return false;
    }
    if filter
        .mailbox_id
        .as_ref()
        .is_some_and(|id| !summary.mailbox_ids.contains(id))
    {
        return false;
    }
    if filter.turn.is_some_and(|turn| summary.turn.holder != turn) {
        return false;
    }
    if filter.unread.is_some_and(|unread| summary.unread != unread) {
        return false;
    }
    if let Some(sender) = &filter.sender
        && listed.sender.as_ref().is_none_or(|from| from.id != *sender)
    {
        return false;
    }
    if let Some(text) = &filter.text {
        let mut haystack = vec![summary.subject.as_str(), summary.snippet.as_str()];
        for who in &summary.people {
            haystack.push(who.name.as_deref().unwrap_or(""));
            haystack.push(&who.address);
        }
        if !haystack.join("\n").to_lowercase().contains(&text.to_lowercase()) {
            return false;
        }
    }
    true
}

/// The message as a client sees it, with its body in whatever state it is in.
fn message<'a>(world: &World, record: &'a MessageRecord, pending: &Pending<'a>, live: &dyn Live) -> Message {
    let me = world
        .accounts
        .get(&record.account_id)
        .map_or("", |account| account.address.as_str());
    let body = match &record.body {
        None => live.missing_body(record),
        Some(BodyResult::Gone) => Body::Unavailable {
            reason: Unavailable::Gone,
        },
        Some(BodyResult::Body { body }) => body::ready(world, record, body),
    };
    let attachments = match &record.body {
        Some(BodyResult::Body { body }) => body.attachments.as_slice(),
        _ => &[],
    };
    Message {
        id: record.id.clone(),
        from: person(&record.facts.from, me),
        sender_verified: record.facts.sender_verified,
        to: record.facts.to.iter().map(|to| person(to, me)).collect(),
        cc: record.facts.cc.iter().map(|cc| person(cc, me)).collect(),
        sent_at: record.facts.sent_at.clone(),
        unread: pending.view_state(record).unread,
        body,
        unsubscribe: body::unsubscribe_of(record),
        attachments: attachments
            .iter()
            .enumerate()
            .map(|(index, attachment)| Attachment {
                blob_id: blob_id_of(&record.id, index),
                name: attachment.name.clone(),
                mime: attachment.mime.clone(),
                size: attachment.size,
                inline: attachment.inline,
            })
            .collect(),
        delivery: delivery(world, record),
    }
}

/// Every mailbox with its message counts, as the user sees them.
pub fn mailboxes(world: &World, rows: &Rows, account_id: Option<&AccountId>) -> Vec<Mailbox> {
    world
        .mailboxes
        .values()
        .filter(|record| account_id.is_none_or(|id| record.account_id == *id))
        .map(|record| {
            let count = rows.counts(&record.id);
            Mailbox {
                id: record.id.clone(),
                account_id: record.account_id.clone(),
                name: record.name.clone(),
                role: record.role,
                parent_id: record.parent.as_ref().and_then(|parent| {
                    world
                        .mailbox_by_ref
                        .get(&scoped(&record.account_id, parent.as_str()))
                        .cloned()
                }),
                unread: count.unread,
                total: count.total,
            }
        })
        .collect()
}

pub fn accounts(world: &World, live: &dyn Live) -> Vec<Account> {
    world.accounts.values().map(|record| account(record, live)).collect()
}

fn account(record: &AccountRecord, live: &dyn Live) -> Account {
    Account {
        id: record.id.clone(),
        address: record.address.clone(),
        provider_label: record.provider_label.clone(),
        can: record.capabilities.into(),
        status: live.status(record),
    }
}

/// One window of a list. `listed` is every thread in the list, in order, and `total` how many there are.
pub fn page<'a>(
    rows: &Rows,
    listed: impl Iterator<Item = &'a ThreadId>,
    total: usize,
    offset: u64,
    limit: u64,
) -> ThreadPage {
    ThreadPage {
        total: total as u64,
        threads: listed
            .skip(usize::try_from(offset).unwrap_or(usize::MAX))
            .take(usize::try_from(limit).unwrap_or(usize::MAX))
            .filter_map(|id| rows.summary(id).cloned())
            .collect(),
    }
}

/// One conversation with all its messages, or None once it has no row.
pub fn thread(world: &World, rows: &Rows, thread_id: &ThreadId, live: &dyn Live) -> Option<ThreadDetail> {
    let summary = rows.summary(thread_id)?.clone();
    let pending = Pending::of(world);
    Some(ThreadDetail {
        summary,
        messages: messages_of(world, thread_id)
            .into_iter()
            .map(|record| message(world, record, &pending, live))
            .collect(),
    })
}

/// What a conversation's answer reads besides its own records: what it shows for each of its
/// messages that has no stored body, and whose choice shows each message's images, which
/// reads the account's senders (see body/mod.rs).
#[derive(Debug, PartialEq)]
pub struct Outside {
    missing: Vec<Body>,
    images: Vec<ShowImages>,
}

pub fn outside(world: &World, thread_id: &ThreadId, live: &dyn Live) -> Outside {
    let records = messages_of(world, thread_id);
    Outside {
        missing: records
            .iter()
            .filter(|record| record.body.is_none())
            .map(|record| live.missing_body(record))
            .collect(),
        images: records.iter().map(|record| body::shown(world, record)).collect(),
    }
}
