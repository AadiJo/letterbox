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

use crate::adapter::{
    AdapterCapabilities, AdapterFailure, BodyResult, Cursor, MailboxRef, MessageRef, PageToken, RemoteFacts,
};
use crate::maps::{HashMap, IndexMap, IndexSet};
use crate::outbox::Outbound;
use crate::store::{Record, Store, Transaction};

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
            // The core answers page-expired itself (see snapshot.rs), so it ends a pass only
            // when an adapter breaks rule 8 by sending it for the first page.
            Err(AdapterFailure::ProviderError | AdapterFailure::PageExpired) => Health::ProviderError,
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
    /// A message the user sent, on its way out (see outbox.rs).
    Send(Outbound),
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
            Op::Send(outbound) => std::slice::from_ref(&outbound.message_id),
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
    pub message_by_ref: Table<HashMap<String, MessageId>>,
    pub mailbox_by_ref: Table<HashMap<String, MailboxId>>,
    pub messages_by_thread: Table<HashMap<ThreadId, IndexSet<MessageId>>>,
    /// Messages by their own Message-ID header.
    pub messages_by_message_id: Table<HashMap<String, IndexSet<MessageId>>>,
    /// Messages by each Message-ID they reply to.
    pub messages_by_reference: Table<HashMap<String, IndexSet<MessageId>>>,
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
}

impl World {
    /// What changed since the last call. Only the views call this, once per commit.
    pub fn take_touched(&mut self) -> Touched {
        std::mem::take(&mut self.touched)
    }
}

/// Marks the threads of the messages an Op names. Those messages look different while it is pending.
fn touch_op(touched: &mut Touched, messages: &IndexMap<MessageId, MessageRecord>, op: Option<&Op>) {
    let named = op.map_or(&[][..], Op::message_ids).iter();
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
    if let Some(r#ref) = record.provider_ref() {
        world
            .message_by_ref
            .0
            .insert(scoped(account, r#ref.as_str()), record.id.clone());
    }
    add_to(&mut world.messages_by_thread.0, record.thread_id.clone(), &record.id);
    if let Some(message_id) = &record.facts.message_id {
        add_to(
            &mut world.messages_by_message_id.0,
            scoped(account, message_id),
            &record.id,
        );
    }
    for reference in &record.facts.references {
        add_to(
            &mut world.messages_by_reference.0,
            scoped(account, reference),
            &record.id,
        );
    }
}

fn unindex(world: &mut World, record: &MessageRecord) {
    let account = &record.account_id;
    if let Some(r#ref) = record.provider_ref() {
        world.message_by_ref.0.remove(&scoped(account, r#ref.as_str()));
    }
    drop_from(&mut world.messages_by_thread.0, &record.thread_id, &record.id);
    if let Some(message_id) = &record.facts.message_id {
        drop_from(
            &mut world.messages_by_message_id.0,
            &scoped(account, message_id),
            &record.id,
        );
    }
    for reference in &record.facts.references {
        drop_from(
            &mut world.messages_by_reference.0,
            &scoped(account, reference),
            &record.id,
        );
    }
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
        message_by_ref: Table(HashMap::default()),
        mailbox_by_ref: Table(HashMap::default()),
        messages_by_thread: Table(HashMap::default()),
        messages_by_message_id: Table(HashMap::default()),
        messages_by_reference: Table(HashMap::default()),
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
    let old = world.changes.get(&record.id).and_then(|old| old.op.as_ref());
    touch_op(&mut world.touched, &world.messages, old);
    touch_op(&mut world.touched, &world.messages, record.op.as_ref());
    world.changes.0.insert(record.id.clone(), record);
}

pub fn remove_change(world: &mut World, tx: &Transaction<'_>, id: &ChangeId) {
    if let Some(record) = world.changes.0.shift_remove(id) {
        touch_op(&mut world.touched, &world.messages, record.op.as_ref());
    }
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
