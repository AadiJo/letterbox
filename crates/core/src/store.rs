//! The one database for every account. It keeps each record as a JSON document
//! in a table named for its kind. The core holds all records in memory and
//! writes every change through here in a transaction, so what is on disk is
//! always a state the core was really in.

use std::cell::Cell;
use std::fmt;
use std::path::Path;

use letterbox_protocol::{AccountId, MailboxId, MessageId, Rev, ThreadId};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use serde::de::DeserializeOwned;

const TABLES: [&str; 5] = ["accounts", "mailboxes", "messages", "threads", "changes"];

/// The core has no answer yet for a failed write (AccountStatus has an `error`
/// state with reason `storage` for that). Until it does, a failed write ends the core.
const WRITE_FAILED: &str = "the store could not write";

/// A kind of record the store keeps, one table per kind.
pub trait Record: Serialize + DeserializeOwned {
    /// The table that holds this kind. One of TABLES.
    const TABLE: &'static str;
    type Id: AsRef<str>;
    fn id(&self) -> &Self::Id;
}

/// An id the store mints: a prefix and a count, for example "thread_12". Change ids come from the client.
pub trait MintedId {
    const PREFIX: &'static str;
    fn minted(value: String) -> Self;
}

macro_rules! minted {
    ($($name:ident => $prefix:literal),* $(,)?) => {$(
        impl MintedId for $name {
            const PREFIX: &'static str = $prefix;
            fn minted(value: String) -> Self {
                $name::new(value)
            }
        }
    )*};
}

minted!(AccountId => "account", MailboxId => "mailbox", MessageId => "message", ThreadId => "thread");

#[derive(Debug)]
pub enum StoreError {
    Folder(std::io::Error),
    Database(rusqlite::Error),
}

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            StoreError::Folder(error) => write!(f, "cannot make the store's folder: {error}"),
            StoreError::Database(error) => write!(f, "cannot open the store: {error}"),
        }
    }
}

impl std::error::Error for StoreError {}

impl From<rusqlite::Error> for StoreError {
    fn from(error: rusqlite::Error) -> Self {
        StoreError::Database(error)
    }
}

pub struct Store {
    db: Connection,
    rev: Cell<Rev>,
    counter: Cell<u64>,
}

/// The writes of one `Store::write` call. They land together or not at all.
pub struct Transaction<'a> {
    store: &'a Store,
}

impl Store {
    /// Opens the store in `data_path`, creating the folder and the tables when they are missing.
    pub fn open(data_path: &Path) -> Result<Store, StoreError> {
        std::fs::create_dir_all(data_path).map_err(StoreError::Folder)?;
        let db = Connection::open(data_path.join("letterbox.sqlite"))?;
        db.execute_batch(
            "pragma journal_mode = wal;
             pragma synchronous = normal;
             create table if not exists meta (key text primary key, value integer not null) strict;",
        )?;
        for table in TABLES {
            db.execute_batch(&format!(
                "create table if not exists {table} \
                 (seq integer primary key autoincrement, id text not null unique, record text not null) strict"
            ))?;
        }
        let meta = |key: &str| -> rusqlite::Result<u64> {
            let value: Option<i64> = db
                .query_row("select value from meta where key = ?", [key], |row| row.get(0))
                .optional()?;
            Ok(value.map_or(0, |value| value.unsigned_abs()))
        };
        let rev = meta("rev")?;
        let counter = meta("counter")?;
        Ok(Store {
            db,
            rev: Cell::new(rev),
            counter: Cell::new(counter),
        })
    }

    /// Every record of one kind, in the order they were first written.
    pub fn load<R: Record>(&self) -> Vec<R> {
        let mut statement = self
            .db
            .prepare_cached(&format!("select record from {} order by seq", R::TABLE))
            .expect("the store's tables exist once it is open");
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .expect("the store can read its own tables");
        rows.map(|row| {
            let text = row.expect("every record is text");
            serde_json::from_str(&text).expect("the store holds only records it wrote")
        })
        .collect()
    }

    /// A new id for a record that this store has never returned, for example "thread_12".
    pub fn next_id<I: MintedId>(&self) -> I {
        let count = self.counter.get() + 1;
        self.counter.set(count);
        I::minted(format!("{}_{count}", I::PREFIX))
    }

    pub fn rev(&self) -> Rev {
        self.rev.get()
    }

    /// Runs `work` as one transaction at the next revision, and returns that revision.
    pub fn write(&self, work: impl FnOnce(&Transaction<'_>, Rev)) -> Rev {
        let next = self.rev.get() + 1;
        // Rolls back when dropped without commit, which covers a panic inside `work`.
        let transaction = self.db.unchecked_transaction().expect(WRITE_FAILED);
        work(&Transaction { store: self }, next);
        self.write_meta("rev", next);
        self.write_meta("counter", self.counter.get());
        transaction.commit().expect(WRITE_FAILED);
        self.rev.set(next);
        next
    }

    fn write_meta(&self, key: &str, value: u64) {
        let value = i64::try_from(value).expect("revisions and counts stay below 2^63");
        self.db
            .prepare_cached(
                "insert into meta (key, value) values (?, ?) on conflict (key) do update set value = excluded.value",
            )
            .and_then(|mut statement| statement.execute(params![key, value]))
            .expect(WRITE_FAILED);
    }
}

impl Transaction<'_> {
    /// Inserts the record, or replaces the one with the same id.
    pub fn put<R: Record>(&self, record: &R) {
        let text = serde_json::to_string(record).expect("records are plain data");
        self.store
            .db
            .prepare_cached(&format!(
                "insert into {} (id, record) values (?, ?) on conflict (id) do update set record = excluded.record",
                R::TABLE
            ))
            .and_then(|mut statement| statement.execute(params![record.id().as_ref(), text]))
            .expect(WRITE_FAILED);
    }

    pub fn remove<R: Record>(&self, id: &R::Id) {
        self.store
            .db
            .prepare_cached(&format!("delete from {} where id = ?", R::TABLE))
            .and_then(|mut statement| statement.execute([id.as_ref()]))
            .expect(WRITE_FAILED);
    }

    /// Same as `Store::next_id`, for code that only holds the transaction.
    pub fn next_id<I: MintedId>(&self) -> I {
        self.store.next_id()
    }
}
