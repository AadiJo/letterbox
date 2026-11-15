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
mod changes;
pub mod clock;
mod dispatch;
mod maps;
mod queue;
mod reconcile;
mod sign_in;
mod store;
mod subscriptions;
mod sync;
mod turns;
mod views;
mod world;

use std::cell::RefCell;
use std::path::PathBuf;
use std::rc::Rc;

use letterbox_protocol::{AccountId, CoreMessage, MessageId, Query, SignInOption, SignInOptionId, SubscriptionId};
use tokio::sync::mpsc;
use tokio_util::task::TaskTracker;

use crate::adapter::{Adapter, AdapterFactory};
use crate::clock::Environment;
use crate::maps::{HashMap, HashSet, IndexMap};
use crate::queue::Job;
use crate::sign_in::Attempts;
use crate::store::Store;
pub use crate::store::StoreError;
use crate::world::{World, load_world};

pub struct CoreOptions {
    /// The folder that holds the store.
    pub data_path: PathBuf,
    pub env: Box<dyn Environment>,
    /// One per way to add an account.
    pub factories: Vec<Rc<dyn AdapterFactory>>,
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
    /// Opens the store and resumes every account that is still signed in.
    /// Call this, and `receive`, inside a tokio LocalSet: the core spawns its work there.
    pub fn new(options: CoreOptions) -> Result<Core, StoreError> {
        if cfg!(panic = "unwind") {
            panic!(
                "letterbox-core must run in a program built with panic = \"abort\". After a panic \
                 its memory can be out of step with the store. Add panic = \"abort\" to the host's \
                 [profile.dev] and [profile.release] in Cargo.toml."
            );
        }
        let store = Store::open(&options.data_path)?;
        let world = load_world(&store);
        let factories: IndexMap<String, Rc<dyn AdapterFactory>> = options
            .factories
            .iter()
            .map(|factory| (factory.option().id.clone(), Rc::clone(factory)))
            .collect();

        let mut adapters: HashMap<AccountId, Linked> = HashMap::default();
        let mut links = 0;
        for account in world.accounts.values() {
            if let Some(factory) = factories.get(&account.factory_id)
                && !account.session.is_empty()
            {
                links += 1;
                let adapter = factory.resume(&account.session);
                adapters.insert(account.id.clone(), Linked { adapter, link: links });
            }
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

        Ok(Core {
            inner: Rc::new(Inner {
                store,
                env: options.env,
                factories,
                options: options_list,
                send: options.send,
                state: RefCell::new(State {
                    world,
                    adapters,
                    subscriptions: IndexMap::default(),
                    syncing: HashSet::default(),
                    loading_bodies: HashSet::default(),
                    unreachable_bodies: HashSet::default(),
                    attempts: Attempts::default(),
                    links,
                }),
                queues: RefCell::new(HashMap::default()),
                work: TaskTracker::new(),
            }),
        })
    }

    /// Takes one decoded message from the client. Anything that is not a valid
    /// message is answered with a protocol-error. Work that has to wait, such as
    /// a sign-in or a sync, continues in tasks on the LocalSet after this returns.
    pub fn receive(&self, value: serde_json::Value) {
        self.inner.receive(value);
    }

    /// Lets work in flight finish, including the work it starts, then releases the
    /// adapters and the store. Idle accounts are not work: an adapter waiting for
    /// nothing does not hold this up. A sign-in still waiting for the user is
    /// cancelled first, so it is answered `cancelled` instead of holding up the close.
    pub async fn close(self) {
        self.inner.state.borrow().attempts.cancel_all();
        self.inner.work.close();
        self.inner.work.wait().await;
        let adapters: Vec<_> = self.inner.state.borrow_mut().adapters.drain().collect();
        for (_, linked) in adapters {
            linked.adapter.close().await;
        }
    }
}

/// What the core holds while it runs. Its methods sit in one module per job: dispatch.rs
/// takes client messages, subscriptions.rs commits and sends updates, queue.rs runs each
/// account's jobs, sync.rs syncs, and accounts.rs signs accounts in and out.
struct Inner {
    store: Store,
    env: Box<dyn Environment>,
    factories: IndexMap<String, Rc<dyn AdapterFactory>>,
    options: Vec<SignInOption>,
    send: Box<dyn Fn(CoreMessage)>,
    state: RefCell<State>,
    /// One queue per account. Each has a task that runs its jobs one at a time.
    queues: RefCell<HashMap<AccountId, mpsc::UnboundedSender<Job>>>,
    /// Every queued job and request task that has not finished. `Core::close` waits for it to empty.
    work: TaskTracker,
}

/// Everything that changes while the core runs. Borrow it only between awaits.
struct State {
    world: World,
    /// The adapter serving each signed-in account.
    adapters: HashMap<AccountId, Linked>,
    /// In the order they were made, which is the order updates go out.
    subscriptions: IndexMap<SubscriptionId, Subscription>,
    syncing: HashSet<AccountId>,
    loading_bodies: HashSet<MessageId>,
    unreachable_bodies: HashSet<MessageId>,
    attempts: Attempts,
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
    /// The JSON of the last answer sent, so an unchanged answer is not sent again.
    sent: String,
}
