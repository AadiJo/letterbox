//! The ways the core reaches the open web, each for something the user asked for: a GET of a
//! remote image the user chose to show (body/fetch.rs), and for an unsubscribe the user
//! confirmed, a DNS TXT lookup of a sender's DKIM key and a one-click POST (unsubscribe/). The
//! core decides what to fetch, checks every redirect hop itself, and passes the bytes on. The
//! host gives it a `Web` that only carries requests.
//!
//! Rules every `Web` follows:
//!   1. One request per call. It never follows a redirect: it answers `Redirect` with the
//!      Location as the server wrote it, and the core decides whether to go on.
//!   2. It sends no cookies, no referrer and no credentials, and keeps nothing between calls.
//!   3. It reads at most `limit` bytes of a body, and answers `TooLarge` past that.
//!   4. It connects only to public addresses: it answers `Refused`, and connects to nothing,
//!      for a host whose address, or any of whose addresses, is loopback, private, link-local
//!      or otherwise not on the public internet, and it connects to the addresses it checked.
//!      A TXT lookup connects to no host, so it has no such check.

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

/// What a one-click POST came to. Whether it reached the server decides whether the core may
/// try another way: a POST that may have arrived is never sent again.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Posted {
    /// The server answered with this status, which is not a redirect.
    Answered { status: u16 },
    /// A 3xx answer. RFC 8058 section 3.1 forbids one, so it is not followed.
    Redirect,
    /// The host's address is not public (rule 4). Nothing was connected to.
    Refused,
    /// No connection was made, so the server surely did not get it.
    NotSent,
    /// The request may have gone out, and no whole answer came back.
    NoAnswer,
}

/// What a TXT lookup found.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Txt {
    /// Each record, its strings joined.
    Records(Vec<String>),
    /// The name has no TXT records, or does not exist.
    None,
    /// The lookup failed: no answer, or a server error.
    Failed,
}

/// Carries the core's web requests. See the rules above.
pub trait Web {
    /// GETs `url`, an absolute https URL.
    fn get(&self, url: &str, limit: usize) -> LocalFuture<'_, Fetched>;
    /// POSTs `List-Unsubscribe=One-Click` to `url`, an absolute https URL, form-encoded
    /// (`application/x-www-form-urlencoded`, which RFC 8058 section 3.2 allows), and reads no
    /// more of the answer than its status.
    fn post_one_click(&self, url: &str) -> LocalFuture<'_, Posted>;
    /// The TXT records of `name`, a DNS name, such as a DKIM key's `<selector>._domainkey.<domain>`.
    fn txt(&self, name: &str) -> LocalFuture<'_, Txt>;
}

/// A `Web` that reaches nothing, for a core that must never fetch, as in the budget test.
pub struct NoWeb;

impl Web for NoWeb {
    fn get(&self, _: &str, _: usize) -> LocalFuture<'_, Fetched> {
        Box::pin(std::future::ready(Fetched::Failed))
    }

    fn post_one_click(&self, _: &str) -> LocalFuture<'_, Posted> {
        Box::pin(std::future::ready(Posted::NotSent))
    }

    fn txt(&self, _: &str) -> LocalFuture<'_, Txt> {
        Box::pin(std::future::ready(Txt::Failed))
    }
}
