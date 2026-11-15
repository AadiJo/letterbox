//! Everything the core knows, held in memory and mirrored to the store.
//! Every change to a record goes through a function in this file, which updates
//! the lookup tables and writes the record in the caller's transaction.
//!
//! Maps that are read in order are IndexMaps, and removal uses `shift_remove`,
//! so iteration follows insertion order. Pending changes are pushed in that
//! order, and lists without a sort of their own are shown in it.

use letterbox_protocol::{
    AccountId, BlobId, ChangeId, ChangeResult, MailboxId, MessageId, Rev, Role, ThreadId, Time, Turn,
};
use serde::{Deserialize, Serialize};

use crate::adapter::{AdapterCapabilities, AdapterFailure, BodyResult, Cursor, MailboxRef, MessageRef, RemoteFacts};
use crate::maps::{HashMap, IndexMap, IndexSet};
use crate::store::{Record, Store, Transaction};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountRecord {
    pub id: AccountId,
    pub address: String,
    pub provider_label: String,
    /// Which sign-in option made this account, so the right factory can resume it.
    pub factory_id: String,
    /// Empty after a sign-out that kept the mail.
    pub session: String,
    pub capabilities: AdapterCapabilities,
    /// None until the first sync finishes.
    pub cursor: Option<Cursor>,
    pub last_synced_at: Option<Time>,
    /// How the last sync pass ended.
    pub health: Health,
}

/// How a sync pass ended: `ok`, or the adapter failure that stopped it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Health {
    Ok,
    Offline,
    NeedsSignIn,
    ProviderError,
}

impl From<Result<(), AdapterFailure>> for Health {
    fn from(result: Result<(), AdapterFailure>) -> Self {
        match result {
            Ok(()) => Health::Ok,
            Err(AdapterFailure::Offline) => Health::Offline,
            Err(AdapterFailure::NeedsSignIn) => Health::NeedsSignIn,
            Err(AdapterFailure::ProviderError) => Health::ProviderError,
        }
    }
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

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageRecord {
    pub id: MessageId,
    pub account_id: AccountId,
    pub r#ref: MessageRef,
    pub thread_id: ThreadId,
    pub facts: RemoteFacts,
    /// What the provider last reported. Pending changes are laid over this to get what the user sees.
    pub server: MessageState,
    /// None until someone opens the message.
    pub body: Option<BodyResult>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadRecord {
    pub id: ThreadId,
    pub account_id: AccountId,
    /// A turn the user set by hand. None leaves it to the rule.
    #[serde(rename = "override")]
    pub turn_override: Option<Turn>,
}

/// A change in the core's own terms: which messages, and what to set on them.
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
    /// None for a change that never leaves the device.
    pub op: Option<Op>,
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
);

pub struct World {
    pub accounts: IndexMap<AccountId, AccountRecord>,
    pub mailboxes: IndexMap<MailboxId, MailboxRecord>,
    pub messages: IndexMap<MessageId, MessageRecord>,
    pub threads: IndexMap<ThreadId, ThreadRecord>,
    /// In the order they were accepted.
    pub changes: IndexMap<ChangeId, ChangeRecord>,
    pub message_by_ref: HashMap<String, MessageId>,
    pub mailbox_by_ref: HashMap<String, MailboxId>,
    pub messages_by_thread: HashMap<ThreadId, IndexSet<MessageId>>,
    /// Messages by their own Message-ID header.
    pub messages_by_message_id: HashMap<String, IndexSet<MessageId>>,
    /// Messages by each Message-ID they reply to.
    pub messages_by_reference: HashMap<String, IndexSet<MessageId>>,
}

/// The id of one attachment: its message and its place in the message. The only place blob ids are made.
pub fn blob_id_of(message_id: &MessageId, index: usize) -> BlobId {
    BlobId::new(format!("blob_{message_id}_{}", index + 1))
}

/// A lookup key that is unique across accounts.
pub fn scoped(account_id: &AccountId, value: &str) -> String {
    format!("{account_id}\n{value}")
}

fn add_to<K: std::hash::Hash + Eq>(index: &mut HashMap<K, IndexSet<MessageId>>, key: K, id: &MessageId) {
    index.entry(key).or_default().insert(id.clone());
}

fn drop_from<K: std::hash::Hash + Eq>(index: &mut HashMap<K, IndexSet<MessageId>>, key: &K, id: &MessageId) {
    let Some(set) = index.get_mut(key) else { return };
    set.shift_remove(id);
    if set.is_empty() {
        index.remove(key);
    }
}

fn index(world: &mut World, record: &MessageRecord) {
    let account = &record.account_id;
    world
        .message_by_ref
        .insert(scoped(account, record.r#ref.as_str()), record.id.clone());
    add_to(&mut world.messages_by_thread, record.thread_id.clone(), &record.id);
    if let Some(message_id) = &record.facts.message_id {
        add_to(
            &mut world.messages_by_message_id,
            scoped(account, message_id),
            &record.id,
        );
    }
    for reference in &record.facts.references {
        add_to(&mut world.messages_by_reference, scoped(account, reference), &record.id);
    }
}

fn unindex(world: &mut World, record: &MessageRecord) {
    let account = &record.account_id;
    world.message_by_ref.remove(&scoped(account, record.r#ref.as_str()));
    drop_from(&mut world.messages_by_thread, &record.thread_id, &record.id);
    if let Some(message_id) = &record.facts.message_id {
        drop_from(
            &mut world.messages_by_message_id,
            &scoped(account, message_id),
            &record.id,
        );
    }
    for reference in &record.facts.references {
        drop_from(
            &mut world.messages_by_reference,
            &scoped(account, reference),
            &record.id,
        );
    }
}

/// Loads every record from the store and builds the lookup tables.
pub fn load_world(store: &Store) -> World {
    fn by_id<R: Record>(store: &Store) -> IndexMap<R::Id, R>
    where
        R::Id: Clone + std::hash::Hash + Eq,
    {
        store
            .load::<R>()
            .into_iter()
            .map(|record| (record.id().clone(), record))
            .collect()
    }
    let mut world = World {
        accounts: by_id(store),
        mailboxes: by_id(store),
        messages: by_id(store),
        threads: by_id(store),
        changes: by_id(store),
        message_by_ref: HashMap::default(),
        mailbox_by_ref: HashMap::default(),
        messages_by_thread: HashMap::default(),
        messages_by_message_id: HashMap::default(),
        messages_by_reference: HashMap::default(),
    };
    for record in world.mailboxes.values() {
        world
            .mailbox_by_ref
            .insert(scoped(&record.account_id, record.r#ref.as_str()), record.id.clone());
    }
    let messages: Vec<MessageRecord> = world.messages.values().cloned().collect();
    for record in &messages {
        index(&mut world, record);
    }
    world
}

pub fn put_account(world: &mut World, tx: &Transaction<'_>, record: AccountRecord) {
    tx.put(&record);
    world.accounts.insert(record.id.clone(), record);
}

pub fn remove_account(world: &mut World, tx: &Transaction<'_>, id: &AccountId) {
    world.accounts.shift_remove(id);
    tx.remove::<AccountRecord>(id);
}

pub fn put_mailbox(world: &mut World, tx: &Transaction<'_>, record: MailboxRecord) {
    tx.put(&record);
    world
        .mailbox_by_ref
        .insert(scoped(&record.account_id, record.r#ref.as_str()), record.id.clone());
    world.mailboxes.insert(record.id.clone(), record);
}

pub fn remove_mailbox(world: &mut World, tx: &Transaction<'_>, id: &MailboxId) {
    if let Some(record) = world.mailboxes.shift_remove(id) {
        world
            .mailbox_by_ref
            .remove(&scoped(&record.account_id, record.r#ref.as_str()));
    }
    tx.remove::<MailboxRecord>(id);
}

/// Writes a message. The lookups of the record it replaces, if any, are cleared first.
pub fn put_message(world: &mut World, tx: &Transaction<'_>, record: MessageRecord) {
    if let Some(replaced) = world.messages.get(&record.id).cloned() {
        unindex(world, &replaced);
    }
    tx.put(&record);
    index(world, &record);
    world.messages.insert(record.id.clone(), record);
}

/// Removes a message and returns it, if it was there.
pub fn remove_message(world: &mut World, tx: &Transaction<'_>, id: &MessageId) -> Option<MessageRecord> {
    let record = world.messages.shift_remove(id)?;
    unindex(world, &record);
    tx.remove::<MessageRecord>(id);
    Some(record)
}

pub fn put_thread(world: &mut World, tx: &Transaction<'_>, record: ThreadRecord) {
    tx.put(&record);
    world.threads.insert(record.id.clone(), record);
}

pub fn remove_thread(world: &mut World, tx: &Transaction<'_>, id: &ThreadId) {
    world.threads.shift_remove(id);
    tx.remove::<ThreadRecord>(id);
}

pub fn put_change(world: &mut World, tx: &Transaction<'_>, record: ChangeRecord) {
    tx.put(&record);
    world.changes.insert(record.id.clone(), record);
}

pub fn remove_change(world: &mut World, tx: &Transaction<'_>, id: &ChangeId) {
    world.changes.shift_remove(id);
    tx.remove::<ChangeRecord>(id);
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
