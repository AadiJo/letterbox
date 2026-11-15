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
//! store. Build the host with `panic = "abort"`, as this workspace does, so a
//! panic ends the program instead of leaving a broken core running.

pub mod adapter;
mod changes;
pub mod clock;
mod maps;
mod reconcile;
mod store;
mod turns;
mod views;
mod world;

use std::cell::{Cell, RefCell};
use std::future::Future;
use std::path::PathBuf;
use std::rc::Rc;

use letterbox_protocol::{
    AccountErrorReason, AccountId, AccountStatus, Answer, BlobError, Body, ChangeId, ChangeResult, ClientMessage,
    Command, CoreMessage, Empty, MessageId, PROTOCOL, PasswordInput, ProtocolErrorReason, Query, Refusal, Request,
    RequestId, Response, Rev, SignInError, SignInOption, SignInOptionId, SignedIn, SubscriptionId, SyncNowError,
    Unavailable,
};
use tokio::sync::{mpsc, oneshot};
use tokio::task::spawn_local;
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

use crate::adapter::{Adapter, AdapterFactory, AdapterFailure, ApplyResult, ChangesResult, LocalFuture, SignInInput};
use crate::changes::{overlay, plan, resolve, targets};
use crate::clock::Environment;
use crate::maps::{HashMap, HashSet, IndexMap};
use crate::reconcile::{Incoming, reconcile};
pub use crate::store::StoreError;
use crate::store::{Store, Transaction};
use crate::views::{Live, evaluate};
use crate::world::{
    AccountRecord, ChangeOutcome, ChangeRecord, Health, MessageRecord, ThreadRecord, World, load_world, messages_of,
    put_account, put_change, put_message, put_thread, remove_account, remove_change, remove_mailbox, remove_message,
    remove_thread,
};

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
        let store = Store::open(&options.data_path)?;
        let world = load_world(&store);
        let factories: IndexMap<String, Rc<dyn AdapterFactory>> = options
            .factories
            .iter()
            .map(|factory| (factory.option().id.clone(), Rc::clone(factory)))
            .collect();

        let mut adapters: HashMap<AccountId, Rc<dyn Adapter>> = HashMap::default();
        for account in world.accounts.values() {
            if let Some(factory) = factories.get(&account.factory_id)
                && !account.session.is_empty()
            {
                adapters.insert(account.id.clone(), factory.resume(&account.session));
            }
        }
        let options_list = options
            .factories
            .iter()
            .map(|factory| {
                let option = factory.option();
                SignInOption {
                    id: SignInOptionId::new(option.id.clone()),
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
                    sign_ins: HashMap::default(),
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
        for attempt in self.inner.state.borrow().sign_ins.values() {
            attempt.signal.cancel();
        }
        self.inner.work.close();
        self.inner.work.wait().await;
        let adapters: Vec<_> = self.inner.state.borrow_mut().adapters.drain().collect();
        for (_, adapter) in adapters {
            adapter.close().await;
        }
    }
}

type PassResult = Result<(), AdapterFailure>;

/// One queued task for an account.
type Job = LocalFuture<'static, ()>;

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
    adapters: HashMap<AccountId, Rc<dyn Adapter>>,
    /// In the order they were made, which is the order updates go out.
    subscriptions: IndexMap<SubscriptionId, Subscription>,
    syncing: HashSet<AccountId>,
    loading_bodies: HashSet<MessageId>,
    unreachable_bodies: HashSet<MessageId>,
    sign_ins: HashMap<SignInOptionId, Rc<Attempt>>,
}

struct Subscription {
    query: Query,
    /// The JSON of the last answer sent, so an unchanged answer is not sent again.
    sent: String,
}

/// One sign-in attempt in flight.
#[derive(Default)]
struct Attempt {
    /// Cancelled when a newer attempt for the same option starts.
    signal: CancellationToken,
    superseded: Cell<bool>,
    /// Cancelled once the attempt has its answer. A newer attempt waits for it.
    answered: CancellationToken,
}

/// Marks a sign-in attempt answered when its task ends, however it ends.
struct Answered {
    core: Rc<Inner>,
    option: SignInOptionId,
    attempt: Rc<Attempt>,
}

impl Drop for Answered {
    fn drop(&mut self) {
        // try_borrow_mut: during a panic the state may still be borrowed, and a second panic would abort.
        if let Ok(mut state) = self.core.state.try_borrow_mut()
            && state
                .sign_ins
                .get(&self.option)
                .is_some_and(|current| Rc::ptr_eq(current, &self.attempt))
        {
            state.sign_ins.remove(&self.option);
        }
        self.attempt.answered.cancel();
    }
}

/// What a view needs from outside the world while the core answers it.
struct LiveState<'a> {
    syncing: &'a HashSet<AccountId>,
    unreachable_bodies: &'a HashSet<MessageId>,
    adapters: &'a HashMap<AccountId, Rc<dyn Adapter>>,
    options: &'a [SignInOption],
}

impl Live for LiveState<'_> {
    fn status(&self, account: &AccountRecord) -> AccountStatus {
        let starting = AccountStatus::Syncing {
            done: 0,
            total: None,
            last_synced_at: account.last_synced_at.clone(),
        };
        if self.syncing.contains(&account.id) {
            return starting;
        }
        let last_synced_at = account.last_synced_at.clone();
        match account.health {
            Health::Ok => match last_synced_at {
                Some(last_synced_at) => AccountStatus::Idle { last_synced_at },
                None => starting,
            },
            Health::Offline => AccountStatus::Offline { last_synced_at },
            Health::NeedsSignIn => AccountStatus::NeedsSignIn,
            Health::ProviderError => AccountStatus::Error {
                reason: AccountErrorReason::Provider,
                last_synced_at,
            },
        }
    }

    fn missing_body(&self, record: &MessageRecord) -> Body {
        if self.unreachable_bodies.contains(&record.id) || !self.adapters.contains_key(&record.account_id) {
            Body::Unavailable {
                reason: Unavailable::Offline,
            }
        } else {
            Body::Loading
        }
    }

    fn options(&self) -> &[SignInOption] {
        self.options
    }
}

impl Inner {
    fn send(&self, message: CoreMessage) {
        (self.send)(message);
    }

    fn accepted(&self, change: &ChangeId, rev: Rev) {
        self.send(CoreMessage::Accepted {
            change: change.clone(),
            rev,
        });
    }

    fn respond(&self, id: RequestId, response: Response) {
        self.send(CoreMessage::Response { id, response });
    }

    /// Sends an update to every subscription whose answer changed, then starts loading bodies someone is looking at.
    fn flush(self: &Rc<Self>) {
        let rev = self.store.rev();
        let mut fetches = Vec::new();
        {
            let mut state = self.state.borrow_mut();
            let State {
                world,
                adapters,
                subscriptions,
                syncing,
                loading_bodies,
                unreachable_bodies,
                ..
            } = &mut *state;
            let live = LiveState {
                syncing: &*syncing,
                unreachable_bodies: &*unreachable_bodies,
                adapters: &*adapters,
                options: &self.options,
            };
            for (sub, entry) in subscriptions.iter_mut() {
                let update = evaluate(world, &entry.query, &live);
                let text = serde_json::to_string(&update).expect("updates are plain data");
                if text == entry.sent {
                    continue;
                }
                entry.sent = text;
                self.send(CoreMessage::Update {
                    sub: sub.clone(),
                    rev,
                    update,
                });
            }
            for entry in subscriptions.values() {
                let Query::Thread { thread_id } = &entry.query else {
                    continue;
                };
                for record in messages_of(world, thread_id) {
                    if record.body.is_some()
                        || loading_bodies.contains(&record.id)
                        || unreachable_bodies.contains(&record.id)
                        || !adapters.contains_key(&record.account_id)
                    {
                        continue;
                    }
                    loading_bodies.insert(record.id.clone());
                    fetches.push((record.account_id.clone(), record.id.clone()));
                }
            }
        }
        for (account_id, id) in fetches {
            self.background(&account_id, Rc::clone(self).fetch_body(id));
        }
    }

    /// The only way the world changes.
    fn commit(self: &Rc<Self>, work: impl FnOnce(&mut World, &Transaction<'_>, Rev)) -> Rev {
        self.commit_then(work, |_| {})
    }

    /// Like `commit`. `announce` runs after the write and before the updates, which is where `accepted` goes.
    fn commit_then(
        self: &Rc<Self>,
        work: impl FnOnce(&mut World, &Transaction<'_>, Rev),
        announce: impl FnOnce(Rev),
    ) -> Rev {
        let rev = {
            let mut state = self.state.borrow_mut();
            let world = &mut state.world;
            self.store.write(|tx, at| work(world, tx, at))
        };
        announce(rev);
        self.flush();
        rev
    }

    /// Runs `task` after everything already queued for this account, and hands back its result.
    fn enqueue<T: 'static>(
        self: &Rc<Self>,
        account_id: &AccountId,
        task: impl Future<Output = T> + 'static,
    ) -> oneshot::Receiver<T> {
        let (sender, receiver) = oneshot::channel();
        // Counts as work from now, not from when the job starts, so the core never looks idle
        // between one job ending and the next one starting.
        let in_flight = self.work.token();
        let job: Job = Box::pin(async move {
            // Nobody waits for a background task's result, so a closed receiver is expected.
            let _ = sender.send(task.await);
            drop(in_flight);
        });
        let mut queues = self.queues.borrow_mut();
        let queue = queues.entry(account_id.clone()).or_insert_with(|| self.start_queue());
        assert!(queue.send(job).is_ok(), "a queue's task lives as long as the core");
        receiver
    }

    /// Queues a task nobody waits for.
    fn background<T: 'static>(self: &Rc<Self>, account_id: &AccountId, task: impl Future<Output = T> + 'static) {
        drop(self.enqueue(account_id, task));
    }

    /// Starts the task that runs one account's jobs in order.
    /// The task holds only the receiver, so it ends when the core drops its sender.
    fn start_queue(&self) -> mpsc::UnboundedSender<Job> {
        let (sender, mut jobs) = mpsc::unbounded_channel::<Job>();
        spawn_local(async move {
            while let Some(job) = jobs.recv().await {
                job.await;
            }
        });
        sender
    }

    async fn fetch_body(self: Rc<Self>, id: MessageId) {
        let found = {
            let state = self.state.borrow();
            state.world.messages.get(&id).and_then(|record| {
                let adapter = state.adapters.get(&record.account_id)?;
                Some((Rc::clone(adapter), record.r#ref.clone()))
            })
        };
        let Some((adapter, r#ref)) = found else {
            self.state.borrow_mut().loading_bodies.remove(&id);
            return;
        };
        let result = adapter.body(r#ref).await;
        let current = {
            let mut state = self.state.borrow_mut();
            state.loading_bodies.remove(&id);
            state.world.messages.get(&id).cloned()
        };
        let Some(current) = current else { return };
        match result {
            Err(_) => {
                self.state.borrow_mut().unreachable_bodies.insert(id);
                self.commit(|_, _, _| {});
            }
            Ok(body) => {
                self.commit(|world, tx, _| {
                    put_message(
                        world,
                        tx,
                        MessageRecord {
                            body: Some(body),
                            ..current
                        },
                    );
                });
            }
        }
    }

    fn settle(self: &Rc<Self>, change: ChangeRecord, result: ChangeResult) {
        let id = change.id.clone();
        let rev = self.commit(|world, tx, at| {
            put_change(
                world,
                tx,
                ChangeRecord {
                    outcome: Some(ChangeOutcome { rev: at, result }),
                    ..change
                },
            );
        });
        self.send(CoreMessage::Settled {
            change: id,
            rev,
            result,
        });
    }

    /// True while `adapter` is still the account's adapter. A sign-out removes it and a new
    /// sign-in replaces it. A pass checks this after every provider call and writes nothing
    /// once it is false, so it cannot bring back records a sign-out deleted, or overwrite
    /// the status a sign-out or sign-in set.
    fn still_current(&self, account_id: &AccountId, adapter: &Rc<dyn Adapter>) -> bool {
        let state = self.state.borrow();
        state
            .adapters
            .get(account_id)
            .is_some_and(|current| Rc::ptr_eq(current, adapter))
    }

    /// Carries every pending change for one account to the provider, oldest first. Stops when the provider is unreachable.
    async fn push(self: &Rc<Self>, account_id: &AccountId, adapter: &Rc<dyn Adapter>) -> PassResult {
        let waiting: Vec<ChangeRecord> = self
            .state
            .borrow()
            .world
            .changes
            .values()
            .filter(|change| &change.account_id == account_id && change.outcome.is_none())
            .cloned()
            .collect();
        for change in waiting {
            if !self.still_current(account_id, adapter) {
                return Ok(());
            }
            let Some(op) = change.op.clone() else { continue };
            let planned = plan(&self.state.borrow().world, &op);
            let Some(steps) = planned else {
                self.settle(change, ChangeResult::Failed(Refusal::UnknownTarget));
                continue;
            };
            let mut refused = None;
            for step in steps {
                let outcome = adapter.apply(step.mutation).await?;
                if !self.still_current(account_id, adapter) {
                    return Ok(());
                }
                match outcome {
                    ApplyResult::Refused { reason } => {
                        refused = Some(reason);
                        break;
                    }
                    ApplyResult::Applied { moved } => {
                        // The provider now holds this part of the change, so it becomes part of what the provider reported.
                        self.commit(|world, tx, _| {
                            for id in &step.message_ids {
                                let Some(record) = world.messages.get(id).cloned() else {
                                    continue;
                                };
                                let r#ref = moved
                                    .iter()
                                    .find(|pair| pair.from == record.r#ref)
                                    .map_or_else(|| record.r#ref.clone(), |pair| pair.to.clone());
                                let server = overlay(&record.server, &step.part, id);
                                put_message(
                                    world,
                                    tx,
                                    MessageRecord {
                                        r#ref,
                                        server,
                                        ..record
                                    },
                                );
                            }
                        });
                    }
                }
            }
            let result = refused.map_or(ChangeResult::Done, |reason| ChangeResult::Failed(reason.into()));
            self.settle(change, result);
        }
        Ok(())
    }

    /// Fetches what changed at the provider. Falls back to a full snapshot when there is no cursor or it expired.
    async fn pull(self: &Rc<Self>, account_id: &AccountId, adapter: &Rc<dyn Adapter>) -> PassResult {
        let cursor = self
            .state
            .borrow()
            .world
            .accounts
            .get(account_id)
            .and_then(|account| account.cursor.clone());
        if let Some(cursor) = cursor
            && let ChangesResult::Changes(set) = adapter.changes(cursor).await?
        {
            if !self.still_current(account_id, adapter) {
                return Ok(());
            }
            self.commit(|world, tx, _| {
                let Some(account) = world.accounts.get(account_id).cloned() else {
                    return;
                };
                let incoming = Incoming {
                    full: false,
                    mailboxes: set.mailboxes,
                    added: set.added,
                    updated: set.updated,
                    removed: set.removed,
                };
                reconcile(world, tx, account_id, incoming);
                let cursor = Some(set.cursor);
                put_account(world, tx, AccountRecord { cursor, ..account });
            });
            return Ok(());
        }

        let mut messages = Vec::new();
        let mut page = None;
        loop {
            let result = adapter.snapshot(page.take()).await?;
            if !self.still_current(account_id, adapter) {
                return Ok(());
            }
            messages.extend(result.messages);
            if let Some(next) = result.next {
                page = Some(next);
                continue;
            }
            self.commit(|world, tx, _| {
                let Some(account) = world.accounts.get(account_id).cloned() else {
                    return;
                };
                let incoming = Incoming {
                    full: true,
                    mailboxes: Some(result.mailboxes),
                    added: messages,
                    updated: Vec::new(),
                    removed: Vec::new(),
                };
                reconcile(world, tx, account_id, incoming);
                put_account(
                    world,
                    tx,
                    AccountRecord {
                        cursor: result.cursor,
                        ..account
                    },
                );
            });
            return Ok(());
        }
    }

    /// One sync pass: push what is pending, then pull when asked, then record how it went.
    async fn pass(self: Rc<Self>, account_id: AccountId, with_pull: bool) -> PassResult {
        let adapter = {
            let state = self.state.borrow();
            let known = state.world.accounts.contains_key(&account_id);
            state.adapters.get(&account_id).filter(|_| known).cloned()
        };
        let Some(adapter) = adapter else { return Ok(()) };
        if with_pull {
            self.state.borrow_mut().syncing.insert(account_id.clone());
            self.commit(|_, _, _| {});
        }
        let mut result = self.push(&account_id, &adapter).await;
        if result.is_ok() && with_pull {
            result = self.pull(&account_id, &adapter).await;
        }
        self.state.borrow_mut().syncing.remove(&account_id);
        if !self.still_current(&account_id, &adapter) {
            // A sign-out or a new sign-in took the account while this pass ran, and its
            // records are theirs now. Only show that this pass stopped syncing.
            if with_pull {
                self.commit(|_, _, _| {});
            }
            return result;
        }

        let account = self.state.borrow().world.accounts.get(&account_id).cloned();
        let Some(account) = account else { return result };
        let synced = result.is_ok() && with_pull;
        if synced {
            let mut state = self.state.borrow_mut();
            let State {
                world,
                unreachable_bodies,
                ..
            } = &mut *state;
            unreachable_bodies.retain(|id| {
                world
                    .messages
                    .get(id)
                    .is_none_or(|record| record.account_id != account_id)
            });
        }
        let health = Health::from(result);
        if with_pull || health != account.health {
            self.commit(|world, tx, _| {
                let last_synced_at = if synced {
                    Some(self.env.now())
                } else {
                    account.last_synced_at.clone()
                };
                put_account(
                    world,
                    tx,
                    AccountRecord {
                        health,
                        last_synced_at,
                        ..account
                    },
                );
            });
        }
        result
    }

    fn on_command(self: &Rc<Self>, change: ChangeId, command: Command) {
        let earlier = self.state.borrow().world.changes.get(&change).cloned();
        if let Some(earlier) = earlier {
            self.send(CoreMessage::Accepted {
                change: change.clone(),
                rev: earlier.accepted_rev,
            });
            if let Some(outcome) = earlier.outcome {
                self.send(CoreMessage::Settled {
                    change,
                    rev: outcome.rev,
                    result: outcome.result,
                });
            }
            return;
        }
        if let Command::SetTurn { thread_ids, turn } = &command {
            // A turn correction never leaves the device, so it is done as soon as it is stored.
            let target = targets(&self.state.borrow().world, thread_ids);
            let target = match target {
                Ok(target) => target,
                Err(reason) => return self.send(CoreMessage::Rejected { change, reason }),
            };
            let turn_override = turn.fixed();
            let rev = self.commit_then(
                |world, tx, at| {
                    for id in &target.thread_ids {
                        if let Some(thread) = world.threads.get(id).cloned() {
                            put_thread(
                                world,
                                tx,
                                ThreadRecord {
                                    turn_override,
                                    ..thread
                                },
                            );
                        }
                    }
                    put_change(
                        world,
                        tx,
                        ChangeRecord {
                            id: change.clone(),
                            account_id: target.account_id.clone(),
                            op: None,
                            accepted_rev: at,
                            outcome: Some(ChangeOutcome {
                                rev: at,
                                result: ChangeResult::Done,
                            }),
                        },
                    );
                },
                |rev| self.accepted(&change, rev),
            );
            return self.send(CoreMessage::Settled {
                change,
                rev,
                result: ChangeResult::Done,
            });
        }

        let resolved = resolve(&self.state.borrow().world, &command);
        let (account_id, op) = match resolved {
            Ok(resolved) => resolved,
            Err(reason) => return self.send(CoreMessage::Rejected { change, reason }),
        };
        self.commit_then(
            |world, tx, at| {
                put_change(
                    world,
                    tx,
                    ChangeRecord {
                        id: change.clone(),
                        account_id: account_id.clone(),
                        op: Some(op),
                        accepted_rev: at,
                        outcome: None,
                    },
                );
            },
            |rev| self.accepted(&change, rev),
        );
        self.background(&account_id, Rc::clone(self).pass(account_id.clone(), false));
    }

    fn sign_in(self: &Rc<Self>, id: RequestId, option: SignInOptionId, password: Option<PasswordInput>) {
        let Some(factory) = self.factories.get(option.as_str()).cloned() else {
            return self.respond(id, Response::SignIn(Answer(Err(SignInError::Denied))));
        };

        // One attempt per option at a time. A new one ends the one before it and waits for
        // that one to be answered, so the two answers always arrive in the order asked.
        let attempt = Rc::new(Attempt::default());
        let prior = self
            .state
            .borrow_mut()
            .sign_ins
            .insert(option.clone(), Rc::clone(&attempt));
        if let Some(prior) = &prior {
            prior.superseded.set(true);
            prior.signal.cancel();
        }
        let core = Rc::clone(self);
        self.work.spawn_local(async move {
            let _answered = Answered {
                core: Rc::clone(&core),
                option,
                attempt: Rc::clone(&attempt),
            };
            if let Some(prior) = prior {
                prior.answered.cancelled().await;
            }
            core.connect(id, password, factory, &attempt).await;
        });
    }

    fn superseded(&self, id: RequestId) {
        self.respond(id, Response::SignIn(Answer(Err(SignInError::Superseded))));
    }

    /// Runs one sign-in attempt to its answer.
    async fn connect(
        self: &Rc<Self>,
        id: RequestId,
        password: Option<PasswordInput>,
        factory: Rc<dyn AdapterFactory>,
        attempt: &Attempt,
    ) {
        if attempt.superseded.get() {
            return self.superseded(id);
        }
        let open_url = {
            let core = Rc::clone(self);
            let id = id.clone();
            Box::new(move |url| core.send(CoreMessage::OpenUrl { id: id.clone(), url }))
        };
        let input = SignInInput {
            password,
            open_url,
            signal: attempt.signal.clone(),
        };
        let result = factory.connect(input).await;
        if attempt.superseded.get() {
            if let Ok(connection) = result {
                connection.adapter.close().await;
            }
            return self.superseded(id);
        }
        let connection = match result {
            Ok(connection) => connection,
            Err(failure) => return self.respond(id, Response::SignIn(Answer(Err(failure.into())))),
        };

        let factory_id = factory.option().id.clone();
        let existing = self
            .state
            .borrow()
            .world
            .accounts
            .values()
            .find(|account| {
                account.factory_id == factory_id && account.address.to_lowercase() == connection.address.to_lowercase()
            })
            .cloned();
        let account_id = existing
            .as_ref()
            .map_or_else(|| self.store.next_id(), |account| account.id.clone());
        // From the supersede check above to the answer below there is no await, so no other
        // sign-in or sign-out can land in between. The adapter this one replaces closes after.
        let capabilities = connection.adapter.capabilities();
        let replaced = self
            .state
            .borrow_mut()
            .adapters
            .insert(account_id.clone(), connection.adapter);
        self.commit(|world, tx, _| {
            put_account(
                world,
                tx,
                AccountRecord {
                    id: account_id.clone(),
                    address: connection.address,
                    provider_label: connection.provider_label,
                    factory_id,
                    session: connection.session,
                    capabilities,
                    cursor: existing.as_ref().and_then(|account| account.cursor.clone()),
                    last_synced_at: existing.and_then(|account| account.last_synced_at),
                    health: Health::Ok,
                },
            );
        });
        let signed_in = SignedIn {
            account_id: account_id.clone(),
        };
        self.respond(id, Response::SignIn(Answer(Ok(signed_in))));
        self.background(&account_id, Rc::clone(self).pass(account_id.clone(), true));
        if let Some(replaced) = replaced {
            self.work.spawn_local(async move { replaced.close().await });
        }
    }

    /// Signs the account out at once. No await stands between taking the adapter and
    /// changing the records, so no sign-in can land in between. The adapter closes
    /// after, which ends a provider call in flight. A pass still running for the
    /// account sees its adapter is gone and writes nothing more (see `still_current`).
    fn sign_out(self: &Rc<Self>, id: RequestId, account_id: AccountId, delete_local_mail: bool) {
        let adapter = self.state.borrow_mut().adapters.remove(&account_id);
        self.commit(|world, tx, _| {
            let Some(account) = world.accounts.get(&account_id).cloned() else {
                return;
            };
            if !delete_local_mail {
                let session = String::new();
                let health = Health::NeedsSignIn;
                return put_account(
                    world,
                    tx,
                    AccountRecord {
                        session,
                        health,
                        ..account
                    },
                );
            }
            let messages: Vec<_> = world
                .messages
                .values()
                .filter(|record| record.account_id == account_id)
                .map(|record| record.id.clone())
                .collect();
            for id in &messages {
                remove_message(world, tx, id);
            }
            let threads: Vec<_> = world
                .threads
                .values()
                .filter(|record| record.account_id == account_id)
                .map(|record| record.id.clone())
                .collect();
            for id in &threads {
                remove_thread(world, tx, id);
            }
            let mailboxes: Vec<_> = world
                .mailboxes
                .values()
                .filter(|record| record.account_id == account_id)
                .map(|record| record.id.clone())
                .collect();
            for id in &mailboxes {
                remove_mailbox(world, tx, id);
            }
            let changes: Vec<_> = world
                .changes
                .values()
                .filter(|record| record.account_id == account_id)
                .map(|record| record.id.clone())
                .collect();
            for id in &changes {
                remove_change(world, tx, id);
            }
            remove_account(world, tx, &account_id);
        });
        self.respond(id, Response::SignOut(Answer(Ok(Empty {}))));
        if let Some(adapter) = adapter {
            self.work.spawn_local(async move { adapter.close().await });
        }
    }

    /// Syncs each account in turn and answers once all have finished. The first
    /// pass is queued before this returns, so it runs ahead of anything the
    /// client sends after this request.
    fn sync_now(self: &Rc<Self>, id: RequestId, account_id: Option<AccountId>) {
        let accounts: Vec<AccountId> = match account_id {
            Some(account_id) => vec![account_id],
            None => self.state.borrow().world.accounts.keys().cloned().collect(),
        };
        let mut accounts = accounts.into_iter();
        let start = |core: &Rc<Self>, account_id: AccountId| {
            core.enqueue(&account_id, Rc::clone(core).pass(account_id.clone(), true))
        };
        let mut next = accounts.next().map(|account_id| start(self, account_id));
        let core = Rc::clone(self);
        self.work.spawn_local(async move {
            let mut offline = false;
            while let Some(pass) = next {
                let result = pass
                    .await
                    .expect("a queued pass runs to its end, since a panic ends the program");
                offline |= result == Err(AdapterFailure::Offline);
                next = accounts.next().map(|account_id| start(&core, account_id));
            }
            let answer = if offline {
                Err(SyncNowError::Offline)
            } else {
                Ok(Empty {})
            };
            core.respond(id, Response::SyncNow(Answer(answer)));
        });
    }

    fn on_request(self: &Rc<Self>, id: RequestId, request: Request) {
        match request {
            Request::SignIn { option, password } => self.sign_in(id, option, password),
            Request::SignOut {
                account_id,
                delete_local_mail,
            } => self.sign_out(id, account_id, delete_local_mail),
            Request::SyncNow { account_id } => self.sync_now(id, account_id),
            Request::Blob { .. } => self.respond(id, Response::Blob(Answer(Err(BlobError::NotSupported)))),
        }
    }

    fn receive(self: &Rc<Self>, value: serde_json::Value) {
        let message = match serde_json::from_value::<ClientMessage>(value) {
            Ok(message) => message,
            Err(error) => {
                return self.send(CoreMessage::ProtocolError {
                    reason: ProtocolErrorReason::Malformed,
                    detail: error.to_string(),
                });
            }
        };
        match message {
            ClientMessage::Hello { protocol } => {
                if protocol != f64::from(PROTOCOL) {
                    return self.send(CoreMessage::ProtocolError {
                        reason: ProtocolErrorReason::VersionMismatch,
                        detail: format!("this core speaks protocol {PROTOCOL}"),
                    });
                }
                self.send(CoreMessage::Welcome {
                    protocol: PROTOCOL,
                    rev: self.store.rev(),
                });
            }
            ClientMessage::Subscribe { sub, query } => {
                let subscription = Subscription {
                    query,
                    sent: String::new(),
                };
                self.state.borrow_mut().subscriptions.insert(sub, subscription);
                self.flush();
            }
            ClientMessage::Unsubscribe { sub } => {
                self.state.borrow_mut().subscriptions.shift_remove(&sub);
            }
            ClientMessage::Command { change, command } => self.on_command(change, command),
            ClientMessage::Request { id, request } => self.on_request(id, request),
        }
    }
}
