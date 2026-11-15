//! Answers the live views a client subscribes to, from the world as it is now.
//! Everything here is a pure read.

use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use indexmap::{IndexMap, IndexSet};
use letterbox_protocol::{
    Account, AccountStatus, Attachment, Body, Mailbox, MailboxId, Message, Person, Query, SignInOption, ThreadDetail,
    ThreadFilter, ThreadId, ThreadPage, ThreadSummary, Unavailable, Update,
};
use regex::Regex;

use crate::adapter::{BodyResult, RemoteAddress};
use crate::changes::{pending_ops, view_state};
use crate::turns::{TurnMessage, decide_turn, is_automated};
use crate::world::{AccountRecord, MessageRecord, Op, World, blob_id_of, messages_of, scoped};

/// The parts of an answer that live outside the world: what is in flight right now.
pub trait Live {
    fn status(&self, account: &AccountRecord) -> AccountStatus;
    /// The body state for a message whose body is not stored yet.
    fn missing_body(&self, record: &MessageRecord) -> Body;
    fn options(&self) -> &[SignInOption];
}

fn same(a: &str, b: &str) -> bool {
    a.to_lowercase() == b.to_lowercase()
}

fn person(address: &RemoteAddress, me: &str) -> Person {
    Person {
        name: address.name.clone(),
        address: address.address.clone(),
        is_me: same(&address.address, me),
    }
}

static REMOTE_CONTENT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)\b(src|srcset|background|poster)\s*=\s*["']?\s*https?:|url\(\s*["']?\s*https?:"#)
        .expect("a valid pattern")
});

/// One row for a thread, or None when the thread has no messages left.
fn summarize(world: &World, thread_id: &ThreadId, pending: &[&Op]) -> Option<ThreadSummary> {
    let thread = world.threads.get(thread_id)?;
    let account = world.accounts.get(&thread.account_id)?;
    let records = messages_of(world, thread_id);
    let (first, last) = (records.first()?, records.last()?);

    let states: Vec<_> = records.iter().map(|record| view_state(record, pending)).collect();
    let mut people: IndexMap<String, Person> = IndexMap::new();
    for record in &records {
        let from = person(&record.facts.from, &account.address);
        people.entry(from.address.to_lowercase()).or_insert(from);
    }
    let turn = decide_turn(
        &records
            .iter()
            .map(|record| TurnMessage {
                from_me: same(&record.facts.from.address, &account.address),
                to_me: record.facts.to.iter().any(|to| same(&to.address, &account.address)),
                to_addresses: record.facts.to.iter().map(|to| to.address.clone()).collect(),
                automated: is_automated(&record.facts),
            })
            .collect::<Vec<_>>(),
        thread.turn_override,
    );
    let ids: HashSet<_> = records.iter().map(|record| &record.id).collect();
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
        pending: pending
            .iter()
            .any(|op| op.message_ids().iter().any(|id| ids.contains(id))),
    })
}

fn matches(summary: &ThreadSummary, filter: &ThreadFilter) -> bool {
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
fn message(world: &World, record: &MessageRecord, pending: &[&Op], live: &dyn Live) -> Message {
    let me = world
        .accounts
        .get(&record.account_id)
        .map_or("", |account| account.address.as_str());
    let body = match &record.body {
        None => live.missing_body(record),
        Some(BodyResult::Gone) => Body::Unavailable {
            reason: Unavailable::Gone,
        },
        Some(BodyResult::Body { body }) => Body::Ready {
            text: body.text.clone(),
            html: body.html.clone(),
            has_remote_content: body.html.as_deref().is_some_and(|html| REMOTE_CONTENT.is_match(html)),
        },
    };
    let attachments = match &record.body {
        Some(BodyResult::Body { body }) => body.attachments.as_slice(),
        _ => &[],
    };
    Message {
        id: record.id.clone(),
        from: person(&record.facts.from, me),
        to: record.facts.to.iter().map(|to| person(to, me)).collect(),
        cc: record.facts.cc.iter().map(|cc| person(cc, me)).collect(),
        sent_at: record.facts.sent_at.clone(),
        unread: view_state(record, pending).unread,
        body,
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
    }
}

#[derive(Default)]
struct Counts {
    total: u64,
    unread: u64,
}

/// Every mailbox with its message counts, as the user sees them.
fn mailboxes(world: &World, pending: &[&Op], account_id: Option<&letterbox_protocol::AccountId>) -> Vec<Mailbox> {
    let mut counts: HashMap<MailboxId, Counts> = HashMap::new();
    for record in world.messages.values() {
        let state = view_state(record, pending);
        for id in state.mailboxes {
            let count = counts.entry(id).or_default();
            count.total += 1;
            count.unread += u64::from(state.unread);
        }
    }
    world
        .mailboxes
        .values()
        .filter(|record| account_id.is_none_or(|id| record.account_id == *id))
        .map(|record| {
            let count = counts.get(&record.id);
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
                unread: count.map_or(0, |count| count.unread),
                total: count.map_or(0, |count| count.total),
            }
        })
        .collect()
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

/// The current answer to one query, paired with the view it answers.
pub fn evaluate(world: &World, query: &Query, live: &dyn Live) -> Update {
    let pending = pending_ops(world);
    match query {
        Query::Accounts => Update::Accounts {
            data: world.accounts.values().map(|record| account(record, live)).collect(),
        },
        Query::SignInOptions => Update::SignInOptions {
            data: live.options().to_vec(),
        },
        Query::Mailboxes { account_id } => Update::Mailboxes {
            data: mailboxes(world, &pending, account_id.as_ref()),
        },
        Query::Threads { filter, offset, limit } => {
            let mut all: Vec<ThreadSummary> = world
                .threads
                .keys()
                .filter_map(|id| summarize(world, id, &pending))
                .filter(|summary| matches(summary, filter))
                .collect();
            all.sort_by(|a, b| b.last_message_at.cmp(&a.last_message_at).then_with(|| a.id.cmp(&b.id)));
            let total = all.len() as u64;
            let threads = all
                .into_iter()
                .skip(usize::try_from(*offset).unwrap_or(usize::MAX))
                .take(usize::try_from(limit.get()).unwrap_or(usize::MAX))
                .collect();
            Update::Threads {
                data: ThreadPage { total, threads },
            }
        }
        Query::Thread { thread_id } => Update::Thread {
            data: summarize(world, thread_id, &pending).map(|summary| ThreadDetail {
                summary,
                messages: messages_of(world, thread_id)
                    .into_iter()
                    .map(|record| message(world, record, &pending, live))
                    .collect(),
            }),
        },
    }
}
