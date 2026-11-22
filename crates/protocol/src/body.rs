//! A message's body as a UI shows it, after the core's body pipeline (crates/core/src/body).
//! The core processes each body once, when it arrives, and keeps the result:
//!   - trackers are taken out of the HTML for good (`Tracker`),
//!   - every other remote image is blocked until the user shows it (`Images`),
//!   - the quoted history at the end is found, so a UI can fold it (`Quote`),
//!   - and an unsubscribe target is read from the headers or the body (`Unsubscribe`).

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Bodies download on demand, so one can be missing while offline. A body that has arrived
/// stays `loading` until the pipeline has run on it.
///
/// `html` is still hostile input. The UI must render it sandboxed, with scripts off and the
/// network off. Only while `images.shown` is not `blocked` may it let images load, and only
/// over https (`img-src https:`). The core never fetches remote content named in a message.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(tag = "state", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum Body {
    Ready {
        /// The plain text, as the message has it.
        text: String,
        /// The HTML for the state `images.shown` is in. Trackers are gone from it in every
        /// state. While images are blocked, each remote image is a placeholder (see `Images`)
        /// and no `url()` in its CSS names a remote image.
        html: Option<String>,
        images: Images,
        /// None when the body ends in no quote.
        quote: Option<Quote>,
        /// The start of the new part, at most 200 characters with runs of space made one: from
        /// the text before its quote, or from the HTML's text before its quote when the text is
        /// blank. A folded message row shows it.
        preview: String,
    },
    Loading,
    Unavailable {
        reason: Unavailable,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum Unavailable {
    Offline,
    TooLarge,
    Gone,
}

/// A message's remote images, and the trackers the core took out. It has blocked images when
/// `remote` is not empty and `shown` is `blocked`.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Images {
    /// Whether the user shows them. Set with the `set-images` command.
    pub shown: ShowImages,
    /// Every remote image URL left after trackers are taken out, once each, in the order the
    /// HTML names them. Empty means showing images changes nothing. While blocked:
    ///   - an `<img>` that loaded one is `<span data-letterbox-image="i">alt</span>`: `i` is the
    ///     URL's index here and the text is the image's alt text, so it can show as one line,
    ///   - an image `<input>`, a `<video>`'s poster or an SVG `<image>` no longer names it and
    ///     carries `data-letterbox-image="i"`,
    ///   - an element whose `background` attribute named one carries `data-letterbox-background="i"`.
    pub remote: Vec<String>,
    /// The trackers taken out, in the order the HTML named them. None of them is in `html`
    /// in any state, so none loads, even once images are shown.
    pub trackers: Vec<Tracker>,
}

/// Whose choice shows a message's remote images. The `set-images` command takes one of these
/// for a message, and the message then reports it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum ShowImages {
    /// Not shown. Every message starts here.
    Blocked,
    /// Shown for this message only.
    Message,
    /// Shown for every message from this sender's address in this account.
    Sender,
}

/// One remote image the core took out as a tracker.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
pub struct Tracker {
    /// The host it would have loaded from, for example "list-manage.com".
    pub host: String,
    pub reason: TrackerReason,
}

/// Why the core judged an image a tracker. The rules are in crates/core/src/body/trackers.rs.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum TrackerReason {
    /// Its host serves only open and click tracking.
    KnownHost,
    /// An `<img>` at most 1 by 1 pixel, or 0 wide or high.
    Tiny,
    /// An `<img>` hidden by `display:none`, `visibility:hidden`, `opacity:0` or `hidden`.
    Hidden,
    /// Its URL's file is named like an open beacon: open, pixel or beacon.
    Beacon,
}

/// The quoted history at the end of a body, so a UI can fold it. `text` and `html` are where it
/// starts, as offsets in UTF-16 code units, what JavaScript's `slice` counts: the new part is
/// `body.text.slice(0, quote.text)`, and the quote is the rest. At least one is set. The body
/// itself stays whole.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Quote {
    /// Into `text`. None when the text ends in no quote.
    pub text: Option<u64>,
    /// Into `html`, in the state `images.shown` is in. None when the HTML ends in no quote.
    /// The new part, `body.html.slice(0, quote.html)`, is a prefix a browser closes by itself.
    pub html: Option<u64>,
    /// How many earlier messages it holds, read from the markup: the deepest nesting of its
    /// levels (`>` in text, `blockquote` in HTML), or its number of Outlook dividers, whichever
    /// is more. At least 1.
    pub earlier: u64,
    /// True when it only repeats what this conversation holds: the message replies to messages
    /// that are all in this conversation (every Message-ID in its References), and to at least
    /// `earlier` of them.
    pub in_conversation: bool,
}

/// How to unsubscribe from the list a message came from: the one way to use, chosen by the
/// core, best first: one-click, then mailto, then a page to open. The core only reads it:
/// acting on it sends mail or a request to the sender, which confirms the address is read.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(tag = "method", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum Unsubscribe {
    /// RFC 8058: a POST of the body `List-Unsubscribe=One-Click` to `url` unsubscribes, with no
    /// page to open. From an https URL in List-Unsubscribe, when List-Unsubscribe-Post says
    /// `List-Unsubscribe=One-Click`. RFC 8058 also asks that a DKIM signature cover both
    /// headers, which the core does not check.
    OneClick { url: String },
    /// An email to `to`, from a `mailto:` URI in List-Unsubscribe. `uri` is the whole URI, with
    /// any subject and body the sender asks for.
    Mailto { to: String, uri: String },
    /// A page to open in the browser: an https URL in List-Unsubscribe, or a link in the body.
    Web { url: String, from: UnsubscribeSource },
}

/// Where a web unsubscribe target came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum UnsubscribeSource {
    /// The List-Unsubscribe header (RFC 2369).
    Header,
    /// A link in the body, before its quote, whose text or address says unsubscribe.
    Body,
}
