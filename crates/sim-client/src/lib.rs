//! The core's side of the sim provider: two sign-in options whose adapters
//! forward every call over the unix socket to packages/sim-provider/src/server.ts.
//! The Rust mirror of packages/sim-provider/src/client.ts.
//!
//! Each sign-in attempt and each adapter has its own socket. An adapter that
//! loses its socket answers `offline` and connects again on its next call.
//! Closing an adapter lets the calls it already sent finish, the way an HTTP
//! client lets a request it sent complete, so a scenario can race a sign-out
//! against a call in flight.

mod keychain;
mod wire;

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::rc::{Rc, Weak};

use letterbox_core::adapter::{
    Adapter, AdapterCapabilities, AdapterFactory, AdapterFailure, ApplyResult, BodyResult, ChangesResult, Connection,
    Cursor, FactoryOption, LocalFuture, MessageRef, Mutation, Outcome, PageToken, SignInFailure, SignInInput,
    SnapshotPage,
};
use letterbox_protocol::SignInMethod;
use serde::de::DeserializeOwned;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;
use tokio::sync::mpsc;
use tokio::task::{JoinHandle, spawn_local};
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

pub use crate::keychain::FileKeychain;
use crate::wire::{Call, CallResult, Dialect, Reply, RequestBody, Session, encode, outcome, sign_in_result};

/// One open socket to the server. Cloning shares the socket.
#[derive(Clone)]
struct Link(Rc<LinkState>);

struct LinkState {
    open: Cell<bool>,
    sent: Cell<u64>,
    /// Requests that still expect a reply, by id. Dropping a sender tells its caller the socket closed.
    waiting: RefCell<HashMap<u64, mpsc::UnboundedSender<Reply>>>,
    /// Lines for the writer task. Taken on close, which ends that task.
    lines: RefCell<Option<mpsc::UnboundedSender<String>>>,
    closing: CancellationToken,
    tasks: RefCell<Vec<JoinHandle<()>>>,
}

impl Drop for LinkState {
    fn drop(&mut self) {
        // The reader task holds only a weak reference. This wakes it, so the socket closes.
        self.closing.cancel();
    }
}

impl LinkState {
    /// Marks the socket closed and tells every waiting caller.
    fn closed(&self) {
        self.open.set(false);
        self.lines.borrow_mut().take();
        self.waiting.borrow_mut().clear();
    }

    fn dispatch(&self, reply: Reply) {
        let id = reply.id();
        // Only an oauth sign-in gets more than one reply, and `open-url` is never its last.
        let sender = match reply {
            Reply::OpenUrl { .. } => self.waiting.borrow().get(&id).cloned(),
            _ => self.waiting.borrow_mut().remove(&id),
        };
        if let Some(sender) = sender {
            // The caller may have stopped listening, which is fine.
            let _ = sender.send(reply);
        }
    }
}

impl Link {
    /// Connects to the server. None if nothing is listening at `socket_path`.
    async fn open(socket_path: &Path) -> Option<Link> {
        let stream = UnixStream::connect(socket_path).await.ok()?;
        let (read, mut write) = stream.into_split();
        let (lines, mut outgoing) = mpsc::unbounded_channel::<String>();
        let state = Rc::new(LinkState {
            open: Cell::new(true),
            sent: Cell::new(0),
            waiting: RefCell::new(HashMap::new()),
            lines: RefCell::new(Some(lines)),
            closing: CancellationToken::new(),
            tasks: RefCell::new(Vec::new()),
        });

        let writer = spawn_local(async move {
            while let Some(line) = outgoing.recv().await {
                if write.write_all(line.as_bytes()).await.is_err() {
                    break;
                }
            }
        });

        let weak: Weak<LinkState> = Rc::downgrade(&state);
        let closing = state.closing.clone();
        let reader = spawn_local(async move {
            let mut lines = BufReader::new(read).lines();
            loop {
                let line = tokio::select! {
                    () = closing.cancelled() => break,
                    line = lines.next_line() => line,
                };
                let Ok(Some(line)) = line else { break };
                if line.is_empty() {
                    continue;
                }
                let reply: Reply = serde_json::from_str(&line)
                    .unwrap_or_else(|error| panic!("sim provider: not a reply ({error}): {line}"));
                let Some(state) = weak.upgrade() else { break };
                state.dispatch(reply);
            }
            if let Some(state) = weak.upgrade() {
                state.closed();
            }
        });
        state.tasks.borrow_mut().extend([writer, reader]);
        Some(Link(state))
    }

    fn is_open(&self) -> bool {
        self.0.open.get()
    }

    /// Sends one request. The receiver gets each reply to it, and ends if the socket closes first.
    fn send(&self, body: &RequestBody) -> mpsc::UnboundedReceiver<Reply> {
        let (sender, replies) = mpsc::unbounded_channel();
        let state = &self.0;
        let lines = state.lines.borrow();
        let Some(lines) = lines.as_ref().filter(|_| state.open.get()) else {
            return replies;
        };
        let id = state.sent.get() + 1;
        state.sent.set(id);
        state.waiting.borrow_mut().insert(id, sender);
        // A closed writer shows up as a closed socket on the reader's side.
        let _ = lines.send(encode(id, body));
        replies
    }

    /// Sends a request that has exactly one reply. None if the socket drops first.
    async fn ask(&self, body: &RequestBody) -> Option<Reply> {
        self.send(body).recv().await
    }

    /// Closes the socket. Returns once it is closed.
    async fn close(&self) {
        let state = &self.0;
        state.closed();
        state.closing.cancel();
        let tasks: Vec<_> = state.tasks.borrow_mut().drain(..).collect();
        for task in tasks {
            // Either task ending on its own, or panicking, still means its half of the socket is gone.
            let _ = task.await;
        }
    }
}

/// The adapter for one signed-in mailbox.
struct SimAdapter {
    socket_path: PathBuf,
    session: Session,
    /// The socket in use. The lock is held while connecting, so calls side by side share one new socket.
    link: tokio::sync::Mutex<Option<Link>>,
    closed: Cell<bool>,
    /// Calls not yet answered. `close` waits for them.
    calls: TaskTracker,
}

impl SimAdapter {
    /// `first` is the socket the sign-in used, or None after `resume`, where the first call connects.
    fn new(socket_path: PathBuf, session: Session, first: Option<Link>) -> Self {
        SimAdapter {
            socket_path,
            session,
            link: tokio::sync::Mutex::new(first),
            closed: Cell::new(false),
            calls: TaskTracker::new(),
        }
    }

    /// The open socket, connecting again if there is none. None when the server cannot be reached.
    async fn reach(&self) -> Option<Link> {
        let mut link = self.link.lock().await;
        if self.closed.get() {
            return None;
        }
        if let Some(open) = link.as_ref().filter(|link| link.is_open()) {
            return Some(open.clone());
        }
        // That socket never opened or has dropped. Open a new one.
        *link = Link::open(&self.socket_path).await;
        link.clone()
    }

    /// Forwards one call. None means it did not reach the server.
    async fn forward(&self, call: Call) -> Option<CallResult> {
        let link = self.reach().await?;
        let body = RequestBody::Call {
            address: self.session.address.clone(),
            call,
        };
        match link.ask(&body).await? {
            Reply::Result { result, .. } => Some(result),
            _ => None,
        }
    }

    async fn call<T: DeserializeOwned>(&self, call: Call) -> Outcome<T> {
        let _in_flight = self.calls.token();
        let method = call.method();
        match self.forward(call).await {
            Some(result) if result.method == method => outcome(result.outcome),
            _ => Err(AdapterFailure::Offline),
        }
    }
}

impl Adapter for SimAdapter {
    fn capabilities(&self) -> AdapterCapabilities {
        AdapterCapabilities {
            modify: self.session.modify,
            send: false,
            multiple_mailboxes: self.session.dialect == Dialect::Labels,
        }
    }

    fn snapshot(&self, page: Option<PageToken>) -> LocalFuture<'_, Outcome<SnapshotPage>> {
        Box::pin(self.call(Call::Snapshot(page)))
    }

    fn changes(&self, cursor: Cursor) -> LocalFuture<'_, Outcome<ChangesResult>> {
        Box::pin(self.call(Call::Changes(cursor)))
    }

    fn body(&self, r#ref: MessageRef) -> LocalFuture<'_, Outcome<BodyResult>> {
        Box::pin(self.call(Call::Body(r#ref)))
    }

    fn apply(&self, mutation: Mutation) -> LocalFuture<'_, Outcome<ApplyResult>> {
        Box::pin(self.call(Call::Apply(mutation)))
    }

    // Each call goes to the server once, so there is no wait between tries to end.
    fn stop_waiting(&self) {}

    fn close(&self) -> LocalFuture<'_, ()> {
        Box::pin(async move {
            self.closed.set(true);
            self.calls.close();
            self.calls.wait().await;
            let link = self.link.lock().await.clone();
            if let Some(link) = link {
                link.close().await;
            }
        })
    }
}

/// Reads a session string back into what `connect` put there. A string that is not one is a core bug.
fn read_session(session: &str) -> Session {
    serde_json::from_str(session).expect("sim provider: not a session string from this provider")
}

/// Ends a sign-in attempt. A success hands the attempt's socket to the new adapter. A failure closes it.
async fn conclude(
    socket_path: &Path,
    link: Link,
    result: Result<Session, SignInFailure>,
) -> Result<Connection, SignInFailure> {
    let session = match result {
        Ok(session) => session,
        Err(failure) => {
            link.close().await;
            return Err(failure);
        }
    };
    let provider_label = match session.dialect {
        Dialect::Labels => "Sim labels",
        Dialect::Folders => "Sim folders",
    };
    Ok(Connection {
        address: session.address.clone(),
        provider_label: provider_label.to_owned(),
        session: serde_json::to_string(&session).expect("sessions are plain data"),
        adapter: Rc::new(SimAdapter::new(socket_path.to_owned(), session, Some(link))),
    })
}

/// One of the two ways to sign in to the sim provider.
struct SimFactory {
    socket_path: PathBuf,
    option: FactoryOption,
}

impl SimFactory {
    async fn by_password(&self, input: SignInInput) -> Result<Connection, SignInFailure> {
        if input.signal.is_cancelled() {
            return Err(SignInFailure::Cancelled);
        }
        let Some(password) = input.password else {
            return Err(SignInFailure::WrongPassword);
        };
        let link = Link::open(&self.socket_path).await.ok_or(SignInFailure::Offline)?;
        let body = RequestBody::SignInPassword {
            address: password.username,
            password: password.password,
        };
        let reply = link.ask(&body).await;
        if input.signal.is_cancelled() {
            return conclude(&self.socket_path, link, Err(SignInFailure::Cancelled)).await;
        }
        let result = match reply {
            Some(Reply::SignedIn { result, .. }) => sign_in_result(result),
            _ => Err(SignInFailure::Offline),
        };
        conclude(&self.socket_path, link, result).await
    }

    async fn by_oauth(&self, input: SignInInput) -> Result<Connection, SignInFailure> {
        if input.signal.is_cancelled() {
            return Err(SignInFailure::Cancelled);
        }
        let link = Link::open(&self.socket_path).await.ok_or(SignInFailure::Offline)?;
        let mut replies = link.send(&RequestBody::SignInOauth);
        let result = loop {
            let reply = tokio::select! {
                () = input.signal.cancelled() => break Err(SignInFailure::Cancelled),
                reply = replies.recv() => reply,
            };
            match reply {
                None => break Err(SignInFailure::Offline),
                Some(Reply::OpenUrl { url, .. }) => (input.open_url)(url),
                Some(Reply::SignedIn { result, .. }) => break sign_in_result(result),
                Some(Reply::Result { .. }) => {}
            }
        };
        // Closing the socket on a failure makes the server forget the attempt.
        conclude(&self.socket_path, link, result).await
    }
}

impl AdapterFactory for SimFactory {
    fn option(&self) -> &FactoryOption {
        &self.option
    }

    fn connect(&self, input: SignInInput) -> LocalFuture<'_, Result<Connection, SignInFailure>> {
        match self.option.method {
            SignInMethod::Password => Box::pin(self.by_password(input)),
            SignInMethod::Oauth => Box::pin(self.by_oauth(input)),
        }
    }

    fn resume(&self, session: &str) -> Rc<dyn Adapter> {
        Rc::new(SimAdapter::new(self.socket_path.clone(), read_session(session), None))
    }
}

/// The two sign-in options for the provider listening at `socket_path`: password first, then oauth.
///   id "sim-password": username is the address, password must match the seed.
///   id "sim-oauth": calls `open_url`, then waits for the scenario to approve or deny it.
pub fn sim_adapter_factories(socket_path: &Path) -> Vec<Rc<dyn AdapterFactory>> {
    let factory = |id: &str, label: &str, method| -> Rc<dyn AdapterFactory> {
        Rc::new(SimFactory {
            socket_path: socket_path.to_owned(),
            option: FactoryOption {
                id: id.to_owned(),
                label: label.to_owned(),
                method,
            },
        })
    };
    vec![
        factory("sim-password", "Sim password", SignInMethod::Password),
        factory("sim-oauth", "Sim oauth", SignInMethod::Oauth),
    ]
}
