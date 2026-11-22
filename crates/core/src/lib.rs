//! The core: one object that takes client messages and sends core messages.
//! It owns the store, runs sync through the adapters, and keeps every
//! subscription up to date. It never touches stdin, stdout or a socket. The
//! program that creates it decides how messages travel.
//!
//! The harness scenarios (packages/harness) drive it as a process through the
//! protocol, and so does any UI. See crates/sim-client/src/main.rs.
//!
//! Order is what makes the protocol's guarantees hold:
//!   - Every change to the world happens inside `commit`, which writes the
//!     store, then sends updates to every subscription whose answer changed.
//!   - `accepted`, `settled` and `response` are sent after the commit they
//!     describe, so a client that has one has already seen its effects.
//!   - Work for one account runs in a queue, one task at a time, so changes
//!     reach the provider in the order the user made them.
//!   - A snapshot lists one page per task and queues the next page behind whatever
//!     is queued by then, so a change made during a backfill reaches the provider
//!     between pages, not after the whole snapshot (see snapshot.rs).
//!
//! The core runs on one thread, inside a tokio `LocalSet`, so its state needs no
//! locks and its steps run in the order above. A host that wants it on another
//! thread gives it a thread of its own and passes messages across.
//!
//! A panic in the core is a bug that can leave its memory out of step with the
//! store, so the program must end on one. `Core::new` refuses to start in a
//! program built to unwind. Set `panic = "abort"` in the host's profiles, as
//! this workspace does.
mod accounts;
pub mod adapter;
mod attachments;
mod changes;
pub mod clock;
mod confirm;
mod dispatch;
mod draft;
mod effect;
mod forward;
mod live_view;
mod maps;
mod mime;
mod outbox;
mod push;
mod queue;
mod reconcile;
mod rows;
pub mod secrets;
mod senders;
mod sign_in;
mod snapshot;
mod store;
mod subscriptions;
mod suggestions;
mod sync;
mod turns;
mod undo;
mod views;
mod work;
mod world;

#[cfg(test)]
mod budget;

use std::cell::RefCell;
use std::path::PathBuf;
use std::rc::Rc;
use std::time::Duration;

use letterbox_protocol::{
    AccountId, ChangeId, CoreMessage, MessageId, Query, SignInOption, SignInOptionId, SubscriptionId,
};
use tokio::sync::mpsc;
use tokio_util::task::TaskTracker;

use crate::adapter::{Adapter, AdapterFactory};
use crate::clock::Environment;
use crate::live_view::LiveView;
use crate::maps::{HashMap, HashSet, IndexMap};
use crate::queue::Job;
use crate::rows::Rows;
use crate::secrets::Secrets;
use crate::sign_in::Attempts;
use crate::snapshot::Backfill;
use crate::store::Store;
pub use crate::store::StoreError;
use crate::suggestions::People;
use crate::work::Meter;
use crate::world::{AccountRecord, Health, World, load_world, put_account};

pub struct CoreOptions {
    /// The folder that holds the store.
    pub data_path: PathBuf,
    pub env: Box<dyn Environment>,
    /// Holds each signed-in account's session. An app passes the system keychain.
    pub secrets: Box<dyn Secrets>,
    /// One per way to add an account.
    pub factories: Vec<Rc<dyn AdapterFactory>>,
    /// How long a send waits before it goes to the provider. `undo` can cancel it until then.
    pub undo_window: Duration,
    /// How long the core looks for a send that may have reached the provider without saying
    /// so, before it fails as unconfirmed (see outbox.rs).
    pub confirm_window: Duration,
    /// Takes every message for the client. It must not call `Core::receive`: the core
    /// sends updates while it holds its state, and a call back in would panic.
    pub send: Box<dyn Fn(CoreMessage)>,
}

/// The running core. `close` stops it once its work is done. Dropping it, and
/// the LocalSet its work runs on, stops it at once instead. Every write is one
/// transaction, so either way the store is one the next start can resume from,
/// and changes still pending are pushed then.
pub struct Core {
    inner: Rc<Inner>,
}

impl Core {
    /// Opens the store and resumes every account that is still signed in. A signed-in
    /// account whose session the secret store cannot give back is marked as needing a
    /// sign-in, which saves a session again.
    /// Call this, and `receive`, inside a tokio LocalSet: the core spawns its work there.
    pub fn new(options: CoreOptions) -> Result<Core, StoreError> {
        if cfg!(panic = "unwind") {
            panic!(
                "letterbox-core must run in a program built with panic = \"abort\". After a panic \
                 its memory can be out of step with the store. Add panic = \"abort\" to the host's \
                 [profile.dev] and [profile.release] in Cargo.toml."
            );
        }
        Core::open(options)
    }

    /// `new` without its check on how the program handles a panic. Tests unwind, so they start the core here.
    fn open(options: CoreOptions) -> Result<Core, StoreError> {
        let store = Store::open(&options.data_path)?;
        let mut world = load_world(&store);
        let factories: IndexMap<String, Rc<dyn AdapterFactory>> = options
            .factories
            .iter()
            .map(|factory| (factory.option().id.clone(), Rc::clone(factory)))
            .collect();

        let mut adapters: HashMap<AccountId, Linked> = HashMap::default();
        let mut links = 0;
        let mut lost: Vec<AccountRecord> = Vec::new();
        for account in world.accounts.values().filter(|account| account.signed_in) {
            let Some(factory) = factories.get(&account.factory_id) else {
                continue;
            };
            match options.secrets.read(&account.id) {
                Ok(Some(session)) => {
                    links += 1;
                    let adapter = factory.resume(&session);
                    adapters.insert(account.id.clone(), Linked { adapter, link: links });
                }
                // The keychain is locked or lost the entry. The account stays signed in, so
                // the next start tries again, but shows it needs a sign-in until then.
                Ok(None) | Err(_) => lost.push(AccountRecord {
                    health: Health::NeedsSignIn,
                    ..account.clone()
                }),
            }
        }
        if !lost.is_empty() {
            store.write(|tx, _| {
                for account in lost {
                    put_account(&mut world, tx, account);
                }
            });
        }
        #[expect(clippy::disallowed_methods, reason = "a sign-in option's id is its factory's id")]
        let options_list = options
            .factories
            .iter()
            .map(|factory| {
                let option = factory.option();
                SignInOption {
                    id: SignInOptionId::minted(option.id.clone()),
                    label: option.label.clone(),
                    method: option.method,
                }
            })
            .collect();

        let core = Core {
            inner: Rc::new(Inner {
                store,
                env: options.env,
                secrets: options.secrets,
                factories,
                options: options_list,
                send: options.send,
                undo_window: options.undo_window,
                confirm_window: options.confirm_window,
                state: RefCell::new(State {
                    world,
                    rows: Rows::default(),
                    people: People::default(),
                    adapters,
                    subscriptions: IndexMap::default(),
                    syncing: HashSet::default(),
                    loading_bodies: HashSet::default(),
                    unreachable_bodies: HashSet::default(),
                    attempts: Attempts::default(),
                    backfills: HashMap::default(),
                    checks: HashSet::default(),
                    pushing: HashSet::default(),
                    held_undos: Vec::new(),
                    wake_at: None,
                    views_now: letterbox_protocol::Time::new(),
                    links,
                }),
                queues: RefCell::new(HashMap::default()),
                work: TaskTracker::new(),
                meter: Meter::default(),
            }),
        };
        core.inner.resume_outbox();
        Ok(core)
    }

    /// Takes one decoded message from the client. Anything that is not a valid
    /// message is answered with a protocol-error. Work that has to wait, such as
    /// a sign-in or a sync, continues in tasks on the LocalSet after this returns.
    pub fn receive(&self, value: serde_json::Value) {
        self.inner.receive(value);
    }

    /// Lets work in flight finish, including the work it starts, then releases the
    /// adapters and the store. Idle accounts are not work: an adapter waiting for
    /// nothing does not hold this up. A backfill stops after the page in flight, and the
    /// account's next sync pass resumes it from the saved page. A sign-in still waiting for the user is
    /// cancelled first, so it is answered `cancelled` instead of holding up the close. Every adapter
    /// stops waiting too (see `Adapter::stop_waiting`), so a call waiting out a rate limit answers
    /// offline at once. The change or page it was for stays saved, and the next start does it.
    pub async fn close(self) {
        self.inner.state.borrow().attempts.cancel_all();
        self.inner.work.close();
        for linked in self.inner.state.borrow().adapters.values() {
            linked.adapter.stop_waiting();
        }
        self.inner.work.wait().await;
        let adapters: Vec<_> = self.inner.state.borrow_mut().adapters.drain().collect();
        for (_, linked) in adapters {
            linked.adapter.close().await;
        }
    }
}

/// What the core holds while it runs. Its methods sit in one module per job: dispatch.rs
/// takes client messages, subscriptions.rs commits and sends updates, queue.rs runs each
/// account's jobs, sync.rs syncs, outbox.rs sends mail, undo.rs takes changes back,
/// accounts.rs signs accounts in and out, and attachments.rs fetches files.
struct Inner {
    store: Store,
    env: Box<dyn Environment>,
    secrets: Box<dyn Secrets>,
    factories: IndexMap<String, Rc<dyn AdapterFactory>>,
    options: Vec<SignInOption>,
    send: Box<dyn Fn(CoreMessage)>,
    undo_window: Duration,
    confirm_window: Duration,
    state: RefCell<State>,
    /// One queue per account. Each has a task that runs its jobs one at a time.
    queues: RefCell<HashMap<AccountId, mpsc::UnboundedSender<Job>>>,
    /// Every queued job and request task that has not finished. `Core::close` waits for it to empty.
    work: TaskTracker,
    /// The view work done so far, which budget.rs holds to a budget.
    meter: Meter,
}

/// Everything that changes while the core runs. Borrow it only between awaits.
struct State {
    world: World,
    /// Every thread's row, rebuilt for what each commit touched. `flush` keeps it in step with `world`.
    rows: Rows,
    /// Everyone the recipients views can suggest, kept in step with `rows` (see suggestions.rs).
    people: People,
    /// The adapter serving each signed-in account.
    adapters: HashMap<AccountId, Linked>,
    /// In the order they were made, which is the order updates go out.
    subscriptions: IndexMap<SubscriptionId, Subscription>,
    syncing: HashSet<AccountId>,
    loading_bodies: HashSet<MessageId>,
    unreachable_bodies: HashSet<MessageId>,
    attempts: Attempts,
    /// The accounts with a snapshot page job queued (see snapshot.rs).
    backfills: HashMap<AccountId, Backfill>,
    /// Sends with a check booked (see confirm.rs). Each has at most one at a time.
    checks: HashSet<ChangeId>,
    /// Changes a pass is carrying to the provider right now (see `Carrying` in push.rs).
    pushing: HashSet<ChangeId>,
    /// Undos that wait for a change a pass is carrying (see undo.rs).
    held_undos: Vec<crate::undo::HeldUndo>,
    /// When the booked wake for a list that splits on age runs (see `book_wake` in subscriptions.rs).
    wake_at: Option<letterbox_protocol::Time>,
    /// The time the lists that split on age go by. Empty until one opens (see subscriptions.rs).
    views_now: letterbox_protocol::Time,
    /// How many adapters have been linked to an account. Each link takes the next number.
    links: u64,
}

/// The adapter serving one account, and the number of the sign-in (or start) that linked
/// it. A new sign-in links a new number, so a pass can tell its adapter was replaced.
#[derive(Clone)]
struct Linked {
    adapter: Rc<dyn Adapter>,
    link: u64,
}

struct Subscription {
    query: Query,
    /// None until the first `flush` after the subscribe opens it.
    view: Option<LiveView>,
    /// The JSON of the last answer sent, so an unchanged answer is not sent again.
    sent: String,
}
