//! Brings the world in line with what an adapter reported. One function takes
//! both a snapshot page and a set of changes, so both follow the same rules.
//!
//! A provider may give a message a new ref when it moves, or renumber every
//! message at once. A message that seems to vanish and reappear in the same
//! report is matched by its fingerprint, so it keeps its id, its thread, its
//! body and any turn the user set. On a snapshot page, a message the snapshot has
//! not listed yet may reappear the same way. A snapshot removes what it never
//! listed only once its last page is in (`remove_unlisted`).

use std::sync::LazyLock;

use letterbox_protocol::{AccountId, MailboxId, MessageId, ThreadId};
use regex::Regex;

use crate::adapter::{MessageRef, RemoteFacts, RemoteMailbox, RemoteMessage, RemoteState};
use crate::maps::{HashMap, HashSet, IndexMap, IndexSet};
use crate::store::Transaction;
use crate::world::{
    MailboxRecord, MessageRecord, MessageState, Origin, ThreadRecord, World, messages_of, put_mailbox, put_message,
    put_thread, remove_mailbox, remove_message, remove_thread, scoped,
};

pub struct Incoming {
    /// Some(round) when `added` is one page of that snapshot round. Listed messages record the round.
    pub page_of: Option<u64>,
    pub mailboxes: Option<Vec<RemoteMailbox>>,
    pub added: Vec<RemoteMessage>,
    pub updated: Vec<RemoteState>,
    pub removed: Vec<MessageRef>,
}

/// Facts that stay the same when a provider gives a message a new ref.
fn fingerprint(facts: &RemoteFacts) -> String {
    [
        facts.message_id.as_deref().unwrap_or(""),
        &facts.sent_at,
        &facts.size.to_string(),
        &facts.from.address,
        &facts.subject,
    ]
    .join("\n")
}

static REPLY_PREFIX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^(\s*(re|fwd?|aw|sv|antw)\s*:)+").expect("a valid pattern"));
static SPACES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+").expect("a valid pattern"));

/// A subject with reply and forward prefixes removed, for comparing.
pub fn normalize_subject(subject: &str) -> String {
    let bare = REPLY_PREFIX.replace(subject, "");
    SPACES.replace_all(&bare, " ").trim().to_lowercase()
}

/// When the oldest message of a thread was sent.
fn oldest_in(world: &World, id: &ThreadId) -> String {
    messages_of(world, id)
        .first()
        .map(|record| record.facts.sent_at.clone())
        .unwrap_or_default()
}

/// Picks the thread a new message belongs to, merging threads it connects.
/// Two messages share a thread when one names the other in its reply chain, or
/// they are copies with the same Message-ID, and their subjects match.
pub fn thread_for(world: &mut World, tx: &Transaction<'_>, account_id: &AccountId, facts: &RemoteFacts) -> ThreadId {
    let subject = normalize_subject(&facts.subject);
    let mut related: IndexSet<MessageId> = IndexSet::default();
    let mut gather = |index: &HashMap<String, IndexSet<MessageId>>, key: &str| {
        if let Some(ids) = index.get(&scoped(account_id, key)) {
            related.extend(ids.iter().cloned());
        }
    };
    for reference in &facts.references {
        gather(&world.messages_by_message_id, reference);
    }
    if let Some(message_id) = &facts.message_id {
        gather(&world.messages_by_message_id, message_id);
        gather(&world.messages_by_reference, message_id);
    }

    let threads: IndexSet<ThreadId> = related
        .iter()
        .filter_map(|id| world.messages.get(id))
        .filter(|record| normalize_subject(&record.facts.subject) == subject)
        .map(|record| record.thread_id.clone())
        .collect();
    if threads.is_empty() {
        let id: ThreadId = tx.next_id();
        put_thread(
            world,
            tx,
            ThreadRecord {
                id: id.clone(),
                account_id: account_id.clone(),
                turn_override: None,
            },
        );
        return id;
    }

    // The thread holding the oldest message survives a merge, so ids stay stable as mail arrives.
    let mut ordered: Vec<(String, ThreadId)> = threads.into_iter().map(|id| (oldest_in(world, &id), id)).collect();
    ordered.sort();
    let mut ordered = ordered.into_iter().map(|(_, id)| id);
    let winner = ordered.next().expect("a non-empty set of threads has a first member");
    for loser in ordered {
        let moving: Vec<MessageRecord> = messages_of(world, &loser).into_iter().cloned().collect();
        for record in moving {
            put_message(
                world,
                tx,
                MessageRecord {
                    thread_id: winner.clone(),
                    ..record
                },
            );
        }
        let kept = world.threads.get(&winner).cloned();
        let turn_override = world.threads.get(&loser).and_then(|thread| thread.turn_override);
        if let (Some(kept), Some(turn_override)) = (kept, turn_override)
            && kept.turn_override.is_none()
        {
            put_thread(
                world,
                tx,
                ThreadRecord {
                    turn_override: Some(turn_override),
                    ..kept
                },
            );
        }
        remove_thread(world, tx, &loser);
    }
    winner
}

/// The mailboxes a remote message is in, as the core's ids. Mailboxes the core does not know are left out.
fn state_of(world: &World, account_id: &AccountId, remote: &RemoteState) -> MessageState {
    MessageState {
        mailboxes: remote
            .mailboxes
            .iter()
            .filter_map(|r#ref| world.mailbox_by_ref.get(&scoped(account_id, r#ref.as_str())).cloned())
            .collect(),
        unread: remote.unread,
        flagged: remote.flagged,
    }
}

/// The message the core holds under this ref, if any.
fn known(world: &World, account_id: &AccountId, r#ref: &MessageRef) -> Option<MessageRecord> {
    let id = world.message_by_ref.get(&scoped(account_id, r#ref.as_str()))?;
    world.messages.get(id).cloned()
}

/// Applies one report from an adapter to the world, inside the caller's transaction.
pub fn reconcile(world: &mut World, tx: &Transaction<'_>, account_id: &AccountId, incoming: Incoming) {
    if let Some(mailboxes) = incoming.mailboxes {
        let mut seen: HashSet<MailboxId> = HashSet::default();
        for remote in mailboxes {
            let id = world
                .mailbox_by_ref
                .get(&scoped(account_id, remote.r#ref.as_str()))
                .cloned()
                .unwrap_or_else(|| tx.next_id());
            seen.insert(id.clone());
            put_mailbox(
                world,
                tx,
                MailboxRecord {
                    id,
                    account_id: account_id.clone(),
                    r#ref: remote.r#ref,
                    name: remote.name,
                    role: remote.role,
                    parent: remote.parent,
                },
            );
        }
        let gone: Vec<MailboxId> = world
            .mailboxes
            .values()
            .filter(|record| &record.account_id == account_id && !seen.contains(&record.id))
            .map(|record| record.id.clone())
            .collect();
        for id in gone {
            remove_mailbox(world, tx, &id);
        }
    }

    // Messages the provider no longer lists under their old ref. Some will turn out to have moved.
    let mut vanished: IndexMap<MessageId, MessageRecord> = IndexMap::default();
    for r#ref in &incoming.removed {
        if let Some(record) = known(world, account_id, r#ref) {
            vanished.insert(record.id.clone(), record);
        }
    }
    let mut unlisted = match incoming.page_of {
        Some(round) => unlisted_by_print(world, account_id, round, &incoming.added),
        None => HashMap::default(),
    };

    for remote in incoming.added {
        let existing = known(world, account_id, &remote.state.r#ref);
        if let Some(existing) = existing.filter(|existing| !vanished.contains_key(&existing.id)) {
            let server = state_of(world, account_id, &remote.state);
            let round = incoming.page_of.unwrap_or(existing.round);
            put_message(
                world,
                tx,
                MessageRecord {
                    server,
                    round,
                    ..existing
                },
            );
            continue;
        }
        let print = fingerprint(&remote.facts);
        let moved = vanished
            .values()
            .find(|record| fingerprint(&record.facts) == print)
            .map(|record| record.id.clone());
        let moved = moved.and_then(|id| vanished.shift_remove(&id)).or_else(|| {
            // Read now, not when the page began: a thread merge earlier in this page may have changed it.
            let id = unlisted.get_mut(&print).and_then(Vec::pop)?;
            world.messages.get(&id).cloned()
        });
        if let Some(moved) = moved {
            let server = state_of(world, account_id, &remote.state);
            put_message(
                world,
                tx,
                MessageRecord {
                    origin: Origin::Provider {
                        r#ref: remote.state.r#ref,
                    },
                    server,
                    round: incoming.page_of.unwrap_or(moved.round),
                    ..moved
                },
            );
            continue;
        }
        // The message id is minted before the thread id. Swapping them renumbers every id in the transcripts.
        let id: MessageId = tx.next_id();
        let thread_id = thread_for(world, tx, account_id, &remote.facts);
        let server = state_of(world, account_id, &remote.state);
        put_message(
            world,
            tx,
            MessageRecord {
                id,
                account_id: account_id.clone(),
                origin: Origin::Provider {
                    r#ref: remote.state.r#ref,
                },
                thread_id,
                facts: remote.facts,
                server,
                body: None,
                round: incoming.page_of.unwrap_or(0),
            },
        );
    }

    for remote in &incoming.updated {
        let existing = known(world, account_id, &remote.r#ref);
        if let Some(existing) = existing.filter(|existing| !vanished.contains_key(&existing.id)) {
            let server = state_of(world, account_id, remote);
            put_message(world, tx, MessageRecord { server, ..existing });
        }
    }

    for id in vanished.keys() {
        remove_with_thread(world, tx, id);
    }
}

/// The account's messages that snapshot `round` has not listed, and that this page does not
/// list under their own ref, by fingerprint. Empty when the page names no ref the core lacks,
/// which is every page of a provider whose refs stay put.
fn unlisted_by_print(
    world: &World,
    account_id: &AccountId,
    round: u64,
    page: &[RemoteMessage],
) -> HashMap<String, Vec<MessageId>> {
    let mut found: HashMap<String, Vec<MessageId>> = HashMap::default();
    if page
        .iter()
        .all(|remote| known(world, account_id, &remote.state.r#ref).is_some())
    {
        return found;
    }
    let listed: HashSet<&MessageRef> = page.iter().map(|remote| &remote.state.r#ref).collect();
    let candidates = world
        .messages
        .values()
        .filter(|record| &record.account_id == account_id && record.round != round)
        .filter(|record| record.provider_ref().is_some_and(|r#ref| !listed.contains(r#ref)));
    // Reversed, so `pop` hands out the oldest record first.
    for record in candidates.rev() {
        found
            .entry(fingerprint(&record.facts))
            .or_default()
            .push(record.id.clone());
    }
    found
}

/// Ends snapshot `round`: removes every message of the account it did not list. The
/// provider no longer has them, or has them only under refs the snapshot listed. Messages
/// in the outbox stay: no snapshot lists them.
pub fn remove_unlisted(world: &mut World, tx: &Transaction<'_>, account_id: &AccountId, round: u64) {
    let gone: Vec<MessageId> = world
        .messages
        .values()
        .filter(|record| record.provider_ref().is_some())
        .filter(|record| &record.account_id == account_id && record.round != round)
        .map(|record| record.id.clone())
        .collect();
    for id in &gone {
        remove_with_thread(world, tx, id);
    }
}

/// Removes a message, and its thread if it was the last message in it.
pub fn remove_with_thread(world: &mut World, tx: &Transaction<'_>, id: &MessageId) {
    let Some(removed) = remove_message(world, tx, id) else {
        return;
    };
    if !world.messages_by_thread.contains_key(&removed.thread_id) {
        remove_thread(world, tx, &removed.thread_id);
    }
}
