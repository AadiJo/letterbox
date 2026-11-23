//! A message's body as a UI shows it, after the core's body pipeline (crates/core/src/body).
//! The core processes each body once, when it arrives, and keeps the result:
//!   - trackers are taken out of the HTML for good (`Tracker`),
//!   - every remote image is a placeholder, and the core fetches it only once the user shows
//!     images (`Images`, `Request::Image`),
//!   - the quoted history at the end is found, so a UI can fold it (`Quote`),
//!   - an unsubscribe target is read from the headers or the body (`Unsubscribe`),
//!   - and every color the HTML sets is named, with a value for a dark reader (`Colors`).

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Bodies download on demand, so one can be missing while offline. A body that has arrived
/// stays `loading` until the pipeline has run on it.
///
/// `html` is still hostile input. The UI must render it sandboxed, with scripts off and the
/// network off in every state (`img-src data: cid:` and `base-uri 'none'`). It names no remote
/// image: shown images come from the core, through `Request::Image`.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(tag = "state", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum Body {
    Ready {
        /// The plain text, as the message has it.
        text: String,
        /// The HTML, the same in every state: trackers gone, each remote image a placeholder
        /// (see `Images`), and no `<base>`.
        html: Option<String>,
        /// True when the message has HTML the core would not pass on, so `html` is null: the
        /// parser could not be sure how a browser would read it, or the check on the core's
        /// own output found something its rules take out. The UI shows `text` instead, or says
        /// the formatting could not be shown safely when `text` is blank.
        html_withheld: bool,
        images: Images,
        /// None when the body ends in no quote.
        quote: Option<Quote>,
        /// The start of the new part, at most 200 characters with runs of space made one: from
        /// the text before its quote, or from the HTML's text before its quote when the text is
        /// blank. A folded message row shows it.
        preview: String,
        /// How to color `html` in a dark reader. None when `html` is.
        colors: Option<Colors>,
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
    /// HTML names them, at most 100. Empty means showing images changes nothing. In `html`,
    /// each is a placeholder that names its index `i` here:
    ///   - an `<img>` is `<span data-letterbox-image="i">alt</span>`, with its alt text, and
    ///     `data-letterbox-width` and `data-letterbox-height` when it had a width or a height,
    ///   - an image `<input>`, a `<video>`'s poster or an SVG `<image>` carries
    ///     `data-letterbox-image="i"` and no longer names the URL,
    ///   - an element whose `background` attribute named one carries `data-letterbox-background="i"`,
    ///   - a CSS `url()` is `var(--letterbox-image-i, none)`.
    ///
    /// While `shown` is not `blocked`, the UI asks for each with `Request::Image` and puts the
    /// bytes in as a `data:` URL.
    pub remote: Vec<String>,
    /// The trackers taken out, in the order the HTML named them. The core never fetches one.
    pub trackers: Vec<Tracker>,
}

/// Whether a message's remote images are shown. The `set-images` command takes one of these
/// for a message, and the message then reports it. The choice is per message only: no provider
/// gives a sure sign of who sent a message (see crates/core/src/body/mod.rs), so none is
/// carried over to other mail from the same address.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum ShowImages {
    /// Not shown. Every message starts here.
    Blocked,
    /// Shown for this message.
    Message,
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

/// The bytes of one remote image, after its `chunk` messages, which carry them as base64.
///
/// The UI binds them through DOM APIs only: it sets the placeholder element's `src` (or
/// `poster`, `href`) to a `data:` URL, or a `--letterbox-image-i` custom property on the
/// frame's root with `style.setProperty`. It never writes them into CSS text the sender wrote.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
pub struct ImageFile {
    /// Read from the bytes, never from the server's word: `image/png`, `image/jpeg`,
    /// `image/gif`, `image/webp` or `image/avif`. SVG is refused.
    pub mime: String,
    pub size: u64,
}

/// Why the core did not fetch an image.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum ImageError {
    /// The message, its body or that index is not there.
    Gone,
    /// The message's images are not shown, or stopped being shown while it was fetched.
    Blocked,
    /// The core will not pass it on: its host's address is not public, it redirected to a
    /// tracker or to a URL that is not https or more than five times, or its bytes are not a
    /// PNG, JPEG, GIF, WebP or AVIF image.
    Refused,
    /// More than 5 MB.
    TooLarge,
    /// The server could not be reached, or answered with an error.
    Unreachable,
}

/// The quoted history at the end of a body, so a UI can fold it. `text` and `html` are where it
/// starts, as offsets in UTF-16 code units, what JavaScript's `slice` counts: the new part is
/// `body.text.slice(0, quote.text)`, and the quote is the rest, with its enclosing markup. At
/// least one is set. The body itself stays whole.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Quote {
    /// Into `text`. None when the text ends in no quote.
    pub text: Option<u64>,
    /// Into `html`. None when the HTML ends in no quote. The new part,
    /// `body.html.slice(0, quote.html)`, is a prefix a browser closes by itself.
    pub html: Option<u64>,
    /// A hint that it only repeats what this conversation holds: true when the message replies
    /// to messages (every Message-ID in its References) that are all in this conversation.
    pub in_conversation: bool,
}

/// How to unsubscribe from the list a message came from: the one way to use, chosen by the
/// core. The core only reads it: acting on it sends mail or a request to the sender, which
/// confirms the address is read.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(tag = "method", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum Unsubscribe {
    /// RFC 8058: a POST of the body `List-Unsubscribe=One-Click` to `url` unsubscribes, with no
    /// page to open. From the first https URL in List-Unsubscribe, when List-Unsubscribe-Post
    /// says `List-Unsubscribe=One-Click`.
    OneClick {
        url: String,
        /// True once a DKIM signature that covers List-Unsubscribe and List-Unsubscribe-Post is
        /// verified, as RFC 8058 requires before a POST. The core does not check that yet, so
        /// it is always false.
        verified: bool,
    },
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

/// How to color a message's HTML in a dark reader. The core replaced each color the HTML sets
/// with `var(--letterbox-color-N, <its own color>)`, where N is the color's index in `palette`:
/// in inline styles and `<style>` blocks, for text (`color`, `text-decoration`), backgrounds
/// (`background`, gradients too) and borders (`border*`, `outline`). A color longhand whose
/// value is not just colors the core reads stays as written, so a browser still drops an
/// invalid one. An element whose `bgcolor` (on body, table parts and cells), `<font color>`,
/// or `<body text>`, `link`, `vlink` or `alink` set one carries `data-letterbox-bg`, `-text`,
/// `-link`, `-vlink` or `-alink` naming its N. A `<style>` at the start of `html` applies it
/// from an anonymous cascade layer, so every rule of the sender's still wins where it did over
/// the attribute. A custom property the sender named `--letterbox-…` is renamed
/// `--sender-letterbox-…`, so only the UI sets these.
///
/// With nothing set, the HTML shows the sender's own colors (`original`). For `dark`, the UI sets
/// each `--letterbox-color-N` to its swatch's `dark` on the frame's root, with
/// `style.setProperty`, as it does for images, and gives the frame its own dark defaults for what
/// the HTML leaves unset (the page, text and links). Those go in a cascade layer declared before
/// `html`, so they rank below every rule of the sender's and the core's.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Colors {
    /// The user's choice for the message's sender. Set with the `set-colors` command.
    pub scheme: ColorScheme,
    pub look: HtmlLook,
    /// Each color the HTML sets, once per role, in the order the HTML first sets it, at most 256.
    /// Text set beside a background, in one rule or on one element, is a swatch of its own for
    /// that background when its dark value differs there. Colors past 256 keep their own value in
    /// both schemes.
    pub palette: Vec<Swatch>,
}

/// How a UI colors a message's HTML. The choice is per sender: by the From address, in the
/// message's account. A sender's choice applies to all its mail, new mail too. Unlike showing
/// images, it changes only how the frame paints: nothing is fetched and the sender learns
/// nothing, so anyone who writes that address in a From gains nothing by it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum ColorScheme {
    /// Restyled for the dark reader with each swatch's `dark`. Every sender starts here.
    Dark,
    /// The sender's own colors, which a UI shows on a dimmed card.
    Original,
}

/// What kind of HTML a message has, so a UI knows whose type to set it in.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum HtmlLook {
    /// Designed mail: it has background images or gradients, layout tables (one nested in
    /// another, or marked `role="presentation"`), or three or more colors with a clear hue, or it
    /// comes from a machine (the core's automated rule). It keeps its layout and type.
    Branded,
    /// A person's plain HTML. A UI sets it in the reader's own type, at the reader's measure.
    Simple,
}

/// One color the HTML sets, for one role.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
pub struct Swatch {
    pub role: ColorRole,
    /// The sender's color, as `#rrggbb`, or `#rrggbbaa` when it is not opaque.
    pub original: String,
    /// Its value for the dark reader (crates/core/src/body/dark.rs), in the same form. The same
    /// hue, with its lightness turned over against the reader's background where the original
    /// was meant for a light page. Text keeps a contrast of at least 4.5:1 (WCAG AA), made more
    /// opaque if it must be, on the dark value of the background set beside it, else on the
    /// reader's background (#1b1b1e). A background keeps 4.5:1 under the reader's text
    /// (#e4e4e4). A border has no floor.
    pub dark: String,
}

/// What a color paints.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum ColorRole {
    Text,
    Background,
    Border,
}
