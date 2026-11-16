//! The messages between this client and packages/sim-provider/src/server.ts: JSON, one message per line.
//! The Rust mirror of packages/sim-provider/src/wire.ts.
//!
//! The client numbers its requests per socket and the server answers with the
//! same id. An adapter call gets one `result` reply. A password sign-in gets one
//! `signed-in` reply. An oauth sign-in gets `open-url`, then `signed-in` once the
//! scenario approves or denies it. Closing the socket cancels a pending oauth attempt.

use letterbox_core::adapter::{
    AdapterFailure, Cursor, MessageRef, Mutation, Outcome, Outgoing, PageToken, SignInFailure,
};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// One adapter call, as sent to the server: `{"method": "snapshot", "arg": null}`.
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "method", content = "arg", rename_all = "kebab-case")]
pub enum Call {
    Snapshot(Option<PageToken>),
    Changes(Cursor),
    Body(MessageRef),
    Apply(Mutation),
    Send(Outgoing),
    /// A Message-ID, without angle brackets.
    Find(String),
}

impl Call {
    /// The `method` the server repeats in its answer.
    pub fn method(&self) -> &'static str {
        match self {
            Call::Snapshot(_) => "snapshot",
            Call::Changes(_) => "changes",
            Call::Body(_) => "body",
            Call::Apply(_) => "apply",
            Call::Send(_) => "send",
            Call::Find(_) => "find",
        }
    }
}

/// The answer to one adapter call. `outcome` is read once the caller knows which type to expect.
#[derive(Clone, Debug, Deserialize)]
pub struct CallResult {
    pub method: String,
    pub outcome: Value,
}

/// What an adapter needs to work again after a core restart. The session string is this as JSON.
/// Field order matches the server's object, so the string is the one the server records as handed out.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Session {
    pub address: String,
    pub dialect: Dialect,
    pub modify: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Dialect {
    Labels,
    Folders,
}

/// A request before the client gives it an id.
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "op", rename_all = "kebab-case")]
pub enum RequestBody {
    SignInPassword { address: String, password: String },
    SignInOauth,
    Call { address: String, call: Call },
}

#[derive(Serialize)]
struct Request<'a> {
    id: u64,
    #[serde(flatten)]
    body: &'a RequestBody,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum Reply {
    OpenUrl { id: u64, url: String },
    SignedIn { id: u64, result: Value },
    Result { id: u64, result: CallResult },
}

impl Reply {
    pub fn id(&self) -> u64 {
        match self {
            Reply::OpenUrl { id, .. } | Reply::SignedIn { id, .. } | Reply::Result { id, .. } => *id,
        }
    }
}

/// Turns one request into its line on the socket.
pub fn encode(id: u64, body: &RequestBody) -> String {
    let mut line = serde_json::to_string(&Request { id, body }).expect("requests are plain data");
    line.push('\n');
    line
}

/// Reads `{"ok": true, ...value}` or `{"ok": false, "failure": ...}`.
/// Both ends of the socket are this repo's code, so a value that does not fit is a bug and panics.
fn ok_or<T: DeserializeOwned, F: DeserializeOwned>(value: Value) -> Result<T, F> {
    #[derive(Deserialize)]
    struct Failed<F> {
        failure: F,
    }
    fn read<V: DeserializeOwned>(value: Value) -> V {
        serde_json::from_value(value).unwrap_or_else(|error| panic!("sim provider: unexpected answer shape: {error}"))
    }
    if value.get("ok") == Some(&Value::Bool(true)) {
        Ok(read(value))
    } else {
        Err(read::<Failed<F>>(value).failure)
    }
}

/// Reads the outcome of an adapter call.
pub fn outcome<T: DeserializeOwned>(value: Value) -> Outcome<T> {
    ok_or::<T, AdapterFailure>(value)
}

/// Reads the result of a sign-in: `{"ok": true, "session": ...}` or a failure.
pub fn sign_in_result(value: Value) -> Result<Session, SignInFailure> {
    #[derive(Deserialize)]
    struct SignedIn {
        session: Session,
    }
    ok_or::<SignedIn, SignInFailure>(value).map(|signed_in| signed_in.session)
}
