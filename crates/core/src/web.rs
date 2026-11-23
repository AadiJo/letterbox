//! The one way the core reaches the open web: a single GET of a remote image the user chose
//! to show (body/fetch.rs). The core decides which URLs to fetch, checks every redirect hop
//! itself, and passes the bytes on. The host gives it a `Web` that only carries requests.
//!
//! Rules every `Web` follows:
//!   1. One request per call. It never follows a redirect: it answers `Redirect` with the
//!      Location as the server wrote it, and the core decides whether to go on.
//!   2. It sends no cookies, no referrer and no credentials, and keeps nothing between calls.
//!   3. It reads at most `limit` bytes of a body, and answers `TooLarge` past that.
//!   4. It connects only to public addresses: it answers `Refused`, and connects to nothing,
//!      for a host whose address, or any of whose addresses, is loopback, private, link-local
//!      or otherwise not on the public internet, and it connects to the addresses it checked.

use crate::adapter::LocalFuture;

/// What one GET found.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Fetched {
    /// A 2xx answer: its Content-Type, without parameters, lowercased, and its body.
    Body { mime: String, bytes: Vec<u8> },
    /// A 3xx answer with a Location header, as written.
    Redirect { location: String },
    /// The body ran past the limit.
    TooLarge,
    /// The host's address is not public (rule 4). Nothing was connected to.
    Refused,
    /// No answer, an error status, or a redirect without a Location.
    Failed,
}

/// Carries the core's image requests to the web. See the rules above.
pub trait Web {
    /// GETs `url`, an absolute https URL.
    fn get(&self, url: &str, limit: usize) -> LocalFuture<'_, Fetched>;
}

/// A `Web` that reaches nothing, for a core that must never fetch, as in the budget test.
pub struct NoWeb;

impl Web for NoWeb {
    fn get(&self, _: &str, _: usize) -> LocalFuture<'_, Fetched> {
        Box::pin(std::future::ready(Fetched::Failed))
    }
}
