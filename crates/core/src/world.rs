//! Everything the core knows, held in memory and mirrored to the store.
//! Every change to a record goes through a function in this file, which updates
//! the lookup tables, writes the record in the caller's transaction, and marks what
//! it touched for the views (see `Touched`). Outside this file the tables are
//! read-only (see `Table`), so no change can skip those steps.
//!
//! Maps that are read in order are IndexMaps, and removal uses `shift_remove`,
//! so iteration follows insertion order. Pending changes are pushed in that
//! order, and lists without a sort of their own are shown in it.

use letterbox_protocol::{
    AccountId, BlobId, ChangeId, ChangeResult, MailboxId, MessageId, Rev, Role, ThreadId, Time, Turn,
};
use std::ops::Deref;

use serde::{Deserialize, Serialize};

use crate::adapter::{AdapterCapabilities, BodyResult, Cursor, MailboxRef, MessageRef, PageToken, RemoteFacts};
use crate::body::{SenderKey, SenderRecord};
use crate::effect::{Effect, effect_or_earlier};
use crate::maps::{HashMap, IndexMap, IndexSet};
use crate::store::{Record, Store, Transaction};
use crate::sync::Health;

mod lookups;
use lookups::{forget_unsubscribe, index, note_unsubscribe, unindex};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountRecord {
    pub id: AccountId,
    pub address: String,
    pub provider_label: String,
    /// Which sign-in option made this account, so the right factory can resume it.
    pub factory_id: String,
    /// True from a sign-in until a sign-out. Only a signed-in account resumes on start.
    /// The session itself lives in the host's secret store (see secrets.rs). This flag,
    /// not whether a secret exists, decides: a sign-out commits before it deletes the
    /// secret, so one left by a crash or a failed delete must not sign the account back in.
    pub signed_in: bool,
    pub capabilities: AdapterCapabilities,
    /// None until the first sync finishes. A snapshot sets it with its last page only.
    pub cursor: Option<Cursor>,
    /// The number of the latest snapshot, finished or not. Each message keeps the number of
    /// the last snapshot that listed it, so the end of a snapshot can remove the rest.
    #[serde(default)]
    pub round: u64,
    /// The snapshot under way, saved with each page so a failure or a restart resumes it.
    #[serde(default)]
    pub snapshot: Option<SnapshotProgress>,
    pub last_synced_at: Option<Time>,
    /// How the last sync pass ended.
    pub health: Health,
}

/// How far a snapshot has got.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotProgress {
    /// Where the next page starts. None before the first page.
    pub next: Option<PageToken>,
    /// How many messages its pages have listed so far.
    pub listed: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailboxRecord {
    pub id: MailboxId,
    pub account_id: AccountId,
    pub r#ref: MailboxRef,
    pub name: String,
    pub role: Option<Role>,
    pub parent: Option<MailboxRef>,
}

/// The part of a message a user can change.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct MessageState {
    pub mailboxes: Vec<MailboxId>,
    pub unread: bool,
    pub flagged: bool,
}

/// Where a message the core holds comes from.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Origin {
    /// The provider reported it under this ref.
    Provider { r#ref: MessageRef },
    /// The user sent it and the provider does not hold it: it waits in the outbox, or the
    /// provider refused it. The change `outbox` carries it out (see outbox.rs).
    Outbox { outbox: ChangeId },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageRecord {
    pub id: MessageId,
    pub account_id: AccountId,
    #[serde(flatten)]
    pub origin: Origin,
    pub thread_id: ThreadId,
    pub facts: RemoteFacts,
    /// What the provider last reported. Pending changes are laid over this to get what the user sees.
    pub server: MessageState,
    /// None until someone opens the message.
    pub body: Option<BodyResult>,
    /// What the body pipeline made of `body`, and the user's choice for its images (body/mod.rs).
    #[serde(default, skip_serializing_if = "crate::body::Reading::is_unset")]
    pub reading: crate::body::Reading,
    /// The latest snapshot that listed it (see `AccountRecord::round`). 0 when only `changes` has.
    #[serde(default)]
    pub round: u64,
}

impl MessageRecord {
    /// Its ref at the provider. None while it is in the outbox.
    pub fn provider_ref(&self) -> Option<&MessageRef> {
        match &self.origin {
            Origin::Provider { r#ref } => Some(r#ref),
            Origin::Outbox { .. } => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadRecord {
    pub id: ThreadId,
    pub account_id: AccountId,
    /// A turn the user set by hand. None leaves it to the rule. It holds only until a newer
    /// message (see `held_override` in turns.rs). Set it with `with_override`.
    #[serde(rename = "override")]
    pub turn_override: Option<Turn>,
    /// When the newest message the provider held was sent, as the user set `turn_override`:
    /// empty when it held none. None for a turn set before this was kept, which holds as before.
    #[serde(default)]
    pub override_since: Option<Time>,
}

/// One edit in the core's own terms: which messages, and what to set on them. A change
/// carries its Ops in its `Effect` (see effect.rs).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum Op {
    Flags {
        message_ids: Vec<MessageId>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        unread: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        flagged: Option<bool>,
    },
    Mailboxes {
        mode: MailboxMode,
        message_ids: Vec<MessageId>,
        add: Vec<MailboxId>,
        remove: Vec<MailboxId>,
    },
}

/// `Sets` adds and removes membership. `Move` takes a message that is in one
/// of `remove` and puts it in `add[0]`, for accounts with plain folders.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MailboxMode {
    Sets,
    Move,
}

impl Op {
    pub fn message_ids(&self) -> &[MessageId] {
        match self {
            Op::Flags { message_ids, .. } | Op::Mailboxes { message_ids, .. } => message_ids,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeRecord {
    pub id: ChangeId,
    pub account_id: AccountId,
    /// What it does, and what it altered. Stores from before effects read `op` (see effect.rs).
    #[serde(alias = "op", deserialize_with = "effect_or_earlier")]
    pub effect: Effect,
    pub accepted_rev: Rev,
    /// None while the change waits to reach the provider.
    pub outcome: Option<ChangeOutcome>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChangeOutcome {
    pub rev: Rev,
    pub result: ChangeResult,
}

macro_rules! record {
    ($($record:ident in $table:literal by $id:ident),* $(,)?) => {$(
        impl Record for $record {
            const TABLE: &'static str = $table;
            type Id = $id;
            fn id(&self) -> &$id {
                &self.id
            }
        }
    )*};
}

record!(
    AccountRecord in "accounts" by AccountId,
    MailboxRecord in "mailboxes" by MailboxId,
    MessageRecord in "messages" by MessageId,
    ThreadRecord in "threads" by ThreadId,
    ChangeRecord in "changes" by ChangeId,
    SenderRecord in "senders" by SenderKey,
);

/// One of the world's tables. Outside this file it can only be read. To change a record,
/// call the put_ or remove_ function for it below.
pub struct Table<T>(T);

impl<T> Deref for Table<T> {
    type Target = T;
    fn deref(&self) -> &T {
        &self.0
    }
}

pub struct World {
    pub accounts: Table<IndexMap<AccountId, AccountRecord>>,
    pub mailboxes: Table<IndexMap<MailboxId, MailboxRecord>>,
    pub messages: Table<IndexMap<MessageId, MessageRecord>>,
    pub threads: Table<IndexMap<ThreadId, ThreadRecord>>,
    /// In the order they were accepted.
    pub changes: Table<IndexMap<ChangeId, ChangeRecord>>,
    /// The user's choices per sender (body/scheme.rs).
    pub senders: Table<IndexMap<SenderKey, SenderRecord>>,
    pub message_by_ref: Table<HashMap<String, MessageId>>,
    pub mailbox_by_ref: Table<HashMap<String, MailboxId>>,
    pub messages_by_thread: Table<HashMap<ThreadId, IndexSet<MessageId>>>,
    /// Messages by their own Message-ID header.
    pub messages_by_message_id: Table<HashMap<String, IndexSet<MessageId>>>,
    /// Messages by each Message-ID they reply to.
    pub messages_by_reference: Table<HashMap<String, IndexSet<MessageId>>>,
    /// The newest unsubscribe from each sender, by `sender_key` (see unsubscribe/).
    pub unsubscribes: Table<HashMap<String, ChangeId>>,
    touched: Touched,
}

/// What changed since the views last caught up, so they rebuild only that (see rows.rs).
#[derive(Default)]
pub struct Touched {
    /// Threads whose record, messages or pending changes changed.
    pub threads: IndexSet<ThreadId>,
    /// True when something every row reads changed: which accounts exist or their addresses,
    /// or which mailboxes exist. True after loading too, before the views have read anything.
    pub everything: bool,
    /// True when an unsubscribe was stored or moved on: what Updates shows of a sender changed,
    /// and no thread did (see `state` in unsubscribe/).
    pub unsubscribes: bool,
}

impl World {
    /// What changed since the last call. Only the views call this, once per commit.
    pub fn take_touched(&mut self) -> Touched {
        std::mem::take(&mut self.touched)
    }
}

/// Marks the threads of the messages a change names. Those messages look different while it is pending.
fn touch_effect(touched: &mut Touched, messages: &IndexMap<MessageId, MessageRecord>, effect: Option<&Effect>) {
    let named = effect.into_iter().flat_map(Effect::named);
    for record in named.filter_map(|id| messages.get(id)) {
        touched.threads.insert(record.thread_id.clone());
    }
}

/// The id of one attachment: its message and its place in the message.
#[expect(clippy::disallowed_methods, reason = "the one place blob ids are made")]
pub fn blob_id_of(message_id: &MessageId, index: usize) -> BlobId {
    BlobId::minted(format!("blob_{message_id}_{}", index + 1))
}

/// A lookup key that is unique across accounts.
pub fn scoped(account_id: &AccountId, value: &str) -> String {
    format!("{account_id}\n{value}")
}

/// Loads every record from the store and builds the lookup tables.
pub fn load_world(store: &Store) -> World {
    fn by_id<R: Record>(store: &Store) -> Table<IndexMap<R::Id, R>>
    where
        R::Id: Clone + std::hash::Hash + Eq,
    {
        Table(
            store
                .load::<R>()
                .into_iter()
                .map(|record| (record.id().clone(), record))
                .collect(),
        )
    }
    let mut world = World {
        accounts: by_id(store),
        mailboxes: by_id(store),
        messages: by_id(store),
        threads: by_id(store),
        changes: by_id(store),
        senders: by_id(store),
        message_by_ref: Table(HashMap::default()),
        mailbox_by_ref: Table(HashMap::default()),
        messages_by_thread: Table(HashMap::default()),
        messages_by_message_id: Table(HashMap::default()),
        messages_by_reference: Table(HashMap::default()),
        unsubscribes: Table(HashMap::default()),
        touched: Touched {
            everything: true,
            ..Touched::default()
        },
    };
    for record in world.mailboxes.values() {
        world
            .mailbox_by_ref
            .0
            .insert(scoped(&record.account_id, record.r#ref.as_str()), record.id.clone());
    }
    let messages: Vec<MessageRecord> = world.messages.values().cloned().collect();
    for record in &messages {
        index(&mut world, record);
    }
    let changes: Vec<ChangeRecord> = world.changes.values().cloned().collect();
    for change in &changes {
        note_unsubscribe(&mut world, change);
    }
    world
}

pub fn put_account(world: &mut World, tx: &Transaction<'_>, record: AccountRecord) {
    tx.put(&record);
    let old = world.accounts.get(&record.id);
    world.touched.everything |= old.is_none_or(|old| old.address != record.address);
    world.accounts.0.insert(record.id.clone(), record);
}

pub fn remove_account(world: &mut World, tx: &Transaction<'_>, id: &AccountId) {
    world.touched.everything |= world.accounts.0.shift_remove(id).is_some();
    tx.remove::<AccountRecord>(id);
}

pub fn put_mailbox(world: &mut World, tx: &Transaction<'_>, record: MailboxRecord) {
    tx.put(&record);
    world.touched.everything |= !world.mailboxes.contains_key(&record.id);
    world
        .mailbox_by_ref
        .0
        .insert(scoped(&record.account_id, record.r#ref.as_str()), record.id.clone());
    world.mailboxes.0.insert(record.id.clone(), record);
}

pub fn remove_mailbox(world: &mut World, tx: &Transaction<'_>, id: &MailboxId) {
    if let Some(record) = world.mailboxes.0.shift_remove(id) {
        world.touched.everything = true;
        world
            .mailbox_by_ref
            .0
            .remove(&scoped(&record.account_id, record.r#ref.as_str()));
    }
    tx.remove::<MailboxRecord>(id);
}

/// Writes a message. The lookups of the record it replaces, if any, are cleared first.
pub fn put_message(world: &mut World, tx: &Transaction<'_>, record: MessageRecord) {
    if let Some(replaced) = world.messages.get(&record.id).cloned() {
        world.touched.threads.insert(replaced.thread_id.clone());
        unindex(world, &replaced);
    }
    tx.put(&record);
    index(world, &record);
    world.touched.threads.insert(record.thread_id.clone());
    world.messages.0.insert(record.id.clone(), record);
}

/// Removes a message and returns it, if it was there.
pub fn remove_message(world: &mut World, tx: &Transaction<'_>, id: &MessageId) -> Option<MessageRecord> {
    let record = world.messages.0.shift_remove(id)?;
    world.touched.threads.insert(record.thread_id.clone());
    unindex(world, &record);
    tx.remove::<MessageRecord>(id);
    Some(record)
}

pub fn put_thread(world: &mut World, tx: &Transaction<'_>, record: ThreadRecord) {
    tx.put(&record);
    world.touched.threads.insert(record.id.clone());
    world.threads.0.insert(record.id.clone(), record);
}

pub fn remove_thread(world: &mut World, tx: &Transaction<'_>, id: &ThreadId) {
    world.touched.threads.insert(id.clone());
    world.threads.0.shift_remove(id);
    tx.remove::<ThreadRecord>(id);
}

pub fn put_change(world: &mut World, tx: &Transaction<'_>, record: ChangeRecord) {
    tx.put(&record);
    let old = world.changes.get(&record.id).map(|old| &old.effect);
    world.touched.unsubscribes |= old.and_then(Effect::unsubscribes).is_some();
    world.touched.unsubscribes |= record.effect.unsubscribes().is_some();
    touch_effect(&mut world.touched, &world.messages, old);
    touch_effect(&mut world.touched, &world.messages, Some(&record.effect));
    note_unsubscribe(world, &record);
    world.changes.0.insert(record.id.clone(), record);
}

pub fn remove_change(world: &mut World, tx: &Transaction<'_>, id: &ChangeId) {
    if let Some(record) = world.changes.0.shift_remove(id) {
        touch_effect(&mut world.touched, &world.messages, Some(&record.effect));
        forget_unsubscribe(world, &record);
    }
    tx.remove::<ChangeRecord>(id);
}

/// Writes a sender's choices, and marks each conversation with mail from it, which shows them.
/// It reads every message, which a user's choice can afford.
pub fn put_sender(world: &mut World, tx: &Transaction<'_>, record: SenderRecord) {
    tx.put(&record);
    let from = |message: &&MessageRecord| {
        message.account_id == record.account_id && message.facts.from.address.to_lowercase() == record.address
    };
    let threads = world
        .messages
        .values()
        .filter(from)
        .map(|message| message.thread_id.clone());
    world.touched.threads.extend(threads);
    world.senders.0.insert(record.id.clone(), record);
}

pub fn remove_sender(world: &mut World, tx: &Transaction<'_>, id: &SenderKey) {
    world.senders.0.shift_remove(id);
    tx.remove::<SenderRecord>(id);
}

/// The messages of one thread, oldest first.
pub fn messages_of<'a>(world: &'a World, thread_id: &ThreadId) -> Vec<&'a MessageRecord> {
    let mut records: Vec<&MessageRecord> = world
        .messages_by_thread
        .get(thread_id)
        .into_iter()
        .flatten()
        .filter_map(|id| world.messages.get(id))
        .collect();
    records.sort_by(|a, b| a.facts.sent_at.cmp(&b.facts.sent_at).then_with(|| a.id.cmp(&b.id)));
    records
}
