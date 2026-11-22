//! Where the adapter sends its requests, and the sources of everything a sign-in
//! must not hard-code. Tests point every field at the fake server in
//! packages/sim-provider/src/gmail and fix the random source and the pause, so a run repeats.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::rc::Rc;
use std::time::Duration;

use letterbox_core::adapter::LocalFuture;

/// Makes 32 fresh bytes. The PKCE verifier and the OAuth state each take one draw.
pub type Random = Rc<dyn Fn() -> [u8; 32]>;

/// Waits out a rate limit: the future ends once the duration has passed. The adapter
/// drops it early when it closes, so a pause need not watch for that itself.
pub type Pause = Rc<dyn Fn(Duration) -> LocalFuture<'static, ()>>;

/// The environment variables a live run reads. Nothing in the repo sets them.
pub const CLIENT_ID_VAR: &str = "LETTERBOX_GMAIL_CLIENT_ID";
pub const CLIENT_SECRET_VAR: &str = "LETTERBOX_GMAIL_CLIENT_SECRET";

/// Everything a Gmail factory needs besides the user.
#[derive(Clone)]
pub struct GmailConfig {
    /// The REST API root, ending before `/gmail/v1`. Real: `https://gmail.googleapis.com`.
    pub api_base: String,
    /// The consent page the user opens.
    /// https://developers.google.com/identity/protocols/oauth2/native-app#step-2:-send-a-request-to-googles-oauth-2.0-server
    pub auth_url: String,
    /// Trades a code or a refresh token for an access token.
    /// https://developers.google.com/identity/protocols/oauth2/native-app#exchange-authorization-code
    pub token_url: String,
    /// The OAuth client of type "Desktop app" in the owner's Google Cloud project.
    pub client_id: String,
    /// Google issues desktop clients a secret, but the native-app guide marks it optional
    /// and says desktop apps cannot keep it confidential. Sent only when set.
    pub client_secret: Option<String>,
    pub loopback: Loopback,
    pub random: Random,
    pub pause: Pause,
    /// Addresses to use for these host names instead of asking DNS. Empty for Google.
    /// Tests give the fake's name an IPv6 and an IPv4 address, the way Google's names
    /// resolve, so the client's dual-stack connect runs in every scenario.
    pub hosts: Vec<(String, Vec<SocketAddr>)>,
    /// How long a request may take, from connecting until its answer's body has been read.
    pub timeouts: Timeouts,
}

/// The time budgets for requests. A request past its budget fails as if the connection had
/// dropped (see `send_once` in api.rs), so a stalled answer cannot hold an account's queue,
/// and with it `Core::close`, for good.
#[derive(Clone, Copy, Debug)]
pub struct Timeouts {
    /// Every call but a transfer: metadata, lists, history, labels, modifies and tokens.
    pub call: Duration,
    /// A call that moves a file: an attachment's download, or a send's upload.
    pub transfer: Duration,
    /// How long any request may go without a byte arriving. A download that stopped moving
    /// then frees the account's queue long before its transfer budget runs out, while one that
    /// is slow but moving finishes.
    pub stall: Duration,
}

/// Google's budgets. A metadata call answers in well under a second, and a page of a list in a
/// few, so a minute is generous on a slow link and still frees a stalled queue within a minute.
/// A file can be 25 MB, about 34 MB as the base64 Gmail sends and takes. Ten minutes moves that
/// at about half a megabit a second. A link that drops packets can pause a few seconds while
/// TCP resends, so half a minute without a byte means the connection is dead.
pub const GOOGLE_TIMEOUTS: Timeouts = Timeouts {
    call: Duration::from_secs(60),
    transfer: Duration::from_secs(600),
    stall: Duration::from_secs(30),
};

/// Where the browser lands after consent. The guide says to listen on 127.0.0.1 at a
/// random available port and put that port in the redirect URI.
/// https://developers.google.com/identity/protocols/oauth2/native-app#redirect-uri_loopback
#[derive(Clone, Debug)]
pub enum Loopback {
    /// The real one: a TCP listener on 127.0.0.1 at a port the system picks.
    Tcp,
    /// For tests, where a random port would change the consent URL on every run. The
    /// redirect URI names `127.0.0.1:<port>`, but the listener is the unix socket
    /// `<dir>/<port>.sock`, where the fake server delivers the redirect. Ports count up
    /// from `first_port`, one per sign-in attempt.
    #[cfg(unix)]
    Unix { dir: PathBuf, first_port: u16 },
}

impl GmailConfig {
    /// Google's real endpoints, a TCP loopback, the system's random source and a real timer.
    pub fn google(client_id: String, client_secret: Option<String>) -> Self {
        GmailConfig {
            api_base: "https://gmail.googleapis.com".to_owned(),
            auth_url: "https://accounts.google.com/o/oauth2/v2/auth".to_owned(),
            token_url: "https://oauth2.googleapis.com/token".to_owned(),
            client_id,
            client_secret,
            loopback: Loopback::Tcp,
            random: Rc::new(os_random),
            pause: Rc::new(timer),
            hosts: Vec::new(),
            timeouts: GOOGLE_TIMEOUTS,
        }
    }

    /// The live configuration, when the owner has set `LETTERBOX_GMAIL_CLIENT_ID` (and
    /// usually `LETTERBOX_GMAIL_CLIENT_SECRET`) to their Google Cloud OAuth client. None
    /// otherwise. No client id or secret lives in the repo.
    pub fn google_from_env() -> Option<Self> {
        let id = std::env::var(CLIENT_ID_VAR).ok().filter(|id| !id.is_empty())?;
        let secret = std::env::var(CLIENT_SECRET_VAR)
            .ok()
            .filter(|secret| !secret.is_empty());
        Some(Self::google(id, secret))
    }
}

/// Waits on tokio's timer. The only wait the adapter makes, and only on a live run.
#[expect(
    clippy::disallowed_methods,
    reason = "a live run must really wait before it asks a rate-limited Gmail again. Tests inject a pause instead"
)]
fn timer(wait: Duration) -> LocalFuture<'static, ()> {
    Box::pin(tokio::time::sleep(wait))
}

/// Bytes from the operating system's random source.
fn os_random() -> [u8; 32] {
    let mut bytes = [0; 32];
    getrandom::fill(&mut bytes).expect("the operating system has a random source");
    bytes
}
