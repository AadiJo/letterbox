//! Which remote images are trackers, and the small readers the rules need: remote URLs,
//! srcset candidates, CSS `url()` references and inline style declarations. html.rs applies them.
//!
//! The rules are conservative. A remote image is a tracker only when one of these holds:
//!   1. known-host: its host is, or is under, one of KNOWN_HOSTS, which serve only open and
//!      click tracking.
//!   2. hidden: an `<img>` with `display:none`, `visibility:hidden` or `opacity:0` in its
//!      inline style, or the `hidden` attribute.
//!   3. tiny: an `<img>` whose width and height are both at most 1px, or either is 0, by its
//!      attributes or its inline style.
//!   4. beacon: the last segment of its URL's path, before any extension, is open, pixel or beacon.
//!
//! Rules 1 and 4 apply to every remote image (see html.rs for which those are). Rules 2 and 3
//! read the element, so they apply to `<img>` only. An image that is not remote (`data:`, `cid:`, a relative URL) is never a
//! tracker, since it reaches no server. Anything these rules miss stays a remote image: it is
//! blocked until the user shows images, as every remote image is.

use letterbox_protocol::TrackerReason;
use serde::{Deserialize, Serialize};
use url::Url;

/// Hosts that serve only open and click tracking, never a newsletter's own images. A host
/// under one of these (us1.list-manage.com) counts too.
const KNOWN_HOSTS: [&str; 14] = [
    "list-manage.com",        // Mailchimp
    "mandrillapp.com",        // Mandrill
    "ct.sendgrid.net",        // SendGrid
    "mailtrack.io",           // Mailtrack
    "mltrk.io",               // Mailtrack
    "t.yesware.com",          // Yesware
    "mailfoogae.appspot.com", // Streak
    "r.superhuman.com",       // Superhuman
    "getnotify.com",          // Notify
    "bananatag.com",          // Bananatag
    "pstmrk.it",              // Postmark
    "cmail19.com",            // Campaign Monitor
    "cmail20.com",            // Campaign Monitor
    "eotrx.substackcdn.com",  // Substack
];

/// The file names, before any extension, of open beacons.
const BEACONS: [&str; 3] = ["open", "pixel", "beacon"];

/// Why an image is a tracker, as the store keeps it. The protocol's `TrackerReason` is its copy for the UI.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Reason {
    KnownHost,
    Hidden,
    Tiny,
    Beacon,
}

impl From<Reason> for TrackerReason {
    fn from(reason: Reason) -> Self {
        match reason {
            Reason::KnownHost => TrackerReason::KnownHost,
            Reason::Hidden => TrackerReason::Hidden,
            Reason::Tiny => TrackerReason::Tiny,
            Reason::Beacon => TrackerReason::Beacon,
        }
    }
}

/// The URL a browser would fetch for `value` when that is an http or https server. `value` is
/// an attribute value with its entities decoded, or a CSS url with its escapes undone. As
/// browsers do (WHATWG URL), tabs and newlines anywhere are dropped, and spaces and control
/// characters at either end. A protocol-relative `//host/x` counts as https.
pub fn remote(value: &str) -> Option<Url> {
    let value: String = value.chars().filter(|c| !matches!(c, '\t' | '\n' | '\r')).collect();
    let value = value.trim_matches(|c: char| c <= ' ');
    let mut chars = value.chars();
    let relative = matches!(chars.next(), Some('/' | '\\')) && matches!(chars.next(), Some('/' | '\\'));
    let url = if relative {
        Url::parse(&format!("https:{value}"))
    } else {
        Url::parse(value)
    };
    url.ok().filter(|url| matches!(url.scheme(), "http" | "https"))
}

/// The host a tracker would have loaded from, for the protocol.
pub fn host(url: &Url) -> String {
    host_of(url).to_owned()
}

/// A URL's host as the rules compare it: lowercase, IDNA in its ASCII form (the URL parser does
/// both, as WHATWG URL says), and without a trailing dot, which names the same host.
fn host_of(url: &Url) -> &str {
    url.host_str().unwrap_or_default().trim_end_matches('.')
}

/// Rules 1 and 4, which read the URL alone. Every URL the pipeline lists and every redirect
/// hop the core follows (fetch.rs) goes through here.
pub fn by_url(url: &Url) -> Option<Reason> {
    let host = host_of(url);
    let known = KNOWN_HOSTS
        .iter()
        .any(|known| host == *known || host.strip_suffix(known).is_some_and(|rest| rest.ends_with('.')));
    if known {
        return Some(Reason::KnownHost);
    }
    let file = url
        .path_segments()
        .and_then(|mut segments| segments.rfind(|segment| !segment.is_empty()))
        .unwrap_or_default()
        .to_ascii_lowercase();
    let stem = file.split('.').next().unwrap_or_default();
    BEACONS.contains(&stem).then_some(Reason::Beacon)
}

/// Rules 2 and 3, from an `<img>`'s attributes, each with its entities decoded.
pub fn by_element(width: Option<&str>, height: Option<&str>, style: Option<&str>, hidden: bool) -> Option<Reason> {
    let declarations = style.map(declarations).unwrap_or_default();
    let property = |name: &str| {
        declarations
            .iter()
            .rev()
            .find(|(property, _)| property == name)
            .map(|(_, value)| value.as_str())
    };
    let opacity = property("opacity").and_then(|value| value.parse::<f64>().ok());
    if hidden || property("display") == Some("none") || property("visibility") == Some("hidden") || opacity == Some(0.0)
    {
        return Some(Reason::Hidden);
    }
    // An inline style's size wins over the attributes, as it does in a browser.
    let width = property("width").or(width).and_then(pixels);
    let height = property("height").or(height).and_then(pixels);
    let tiny = match (width, height) {
        (Some(width), Some(height)) => width <= 1.0 && height <= 1.0 || width == 0.0 || height == 0.0,
        (Some(only), None) | (None, Some(only)) => only == 0.0,
        (None, None) => false,
    };
    tiny.then_some(Reason::Tiny)
}

/// A length in pixels: a number, alone or with `px`. None for any other unit, such as `%`.
fn pixels(value: &str) -> Option<f64> {
    let value = value.trim().to_ascii_lowercase();
    value.strip_suffix("px").unwrap_or(&value).trim().parse().ok()
}

/// An inline style's declarations, as lowercase property and value, without `!important`.
fn declarations(style: &str) -> Vec<(String, String)> {
    style
        .split(';')
        .filter_map(|declaration| declaration.split_once(':'))
        .map(|(property, value)| {
            let value = value.trim().to_ascii_lowercase();
            let value = value.strip_suffix("!important").unwrap_or(&value).trim().to_owned();
            (property.trim().to_ascii_lowercase(), value)
        })
        .collect()
}

/// One image candidate of a srcset: its URL and its descriptors, such as "2x".
pub struct Candidate<'a> {
    pub url: &'a str,
    pub descriptors: &'a str,
}

/// A srcset's candidates, read the way the HTML standard reads them: a URL runs to the next
/// space, a comma at its end ends the candidate, and descriptors run to the next comma
/// outside parentheses.
pub fn srcset(value: &str) -> Vec<Candidate<'_>> {
    let mut candidates = Vec::new();
    let mut rest = value;
    loop {
        rest = rest.trim_start_matches(|c: char| c.is_ascii_whitespace() || c == ',');
        if rest.is_empty() {
            return candidates;
        }
        let end = rest.find(|c: char| c.is_ascii_whitespace()).unwrap_or(rest.len());
        let (url, after) = rest.split_at(end);
        rest = after;
        let bare = url.trim_end_matches(',');
        if bare.len() < url.len() {
            candidates.push(Candidate {
                url: bare,
                descriptors: "",
            });
            continue;
        }
        let mut depth = 0_u32;
        let cut = rest
            .char_indices()
            .find(|&(_, c)| {
                match c {
                    '(' => depth += 1,
                    ')' => depth = depth.saturating_sub(1),
                    _ => {}
                }
                c == ',' && depth == 0
            })
            .map_or(rest.len(), |(index, _)| index);
        candidates.push(Candidate {
            url,
            descriptors: rest[..cut].trim(),
        });
        rest = &rest[cut..];
    }
}

/// Writes candidates back as a srcset.
pub fn join_srcset(candidates: &[Candidate<'_>]) -> String {
    let each = candidates.iter().map(|candidate| {
        if candidate.descriptors.is_empty() {
            candidate.url.to_owned()
        } else {
            format!("{} {}", candidate.url, candidate.descriptors)
        }
    });
    each.collect::<Vec<_>>().join(", ")
}

/// One `url(...)` in CSS that names an image: where it sits in the CSS, and its URL with
/// CSS escapes undone.
pub struct CssUrl {
    pub start: usize,
    pub end: usize,
    pub url: String,
}

/// Every `url(...)` in `css` that can name an image. One in an `@import` or a `src:`
/// declaration names a stylesheet or a font, which the renderer's policy blocks in every
/// state, so it is left out. Comments are not skipped: a url in one is read like any other.
pub fn css_urls(css: &str) -> Vec<CssUrl> {
    let bytes = css.as_bytes();
    let mut found = Vec::new();
    let mut at = 0;
    while let Some(offset) = bytes[at..].windows(4).position(|w| w.eq_ignore_ascii_case(b"url(")) {
        let start = at + offset;
        at = start + 4;
        let named = start > 0 && (bytes[start - 1].is_ascii_alphanumeric() || matches!(bytes[start - 1], b'-' | b'_'));
        if named {
            continue;
        }
        let mut index = at;
        while index < bytes.len() && bytes[index].is_ascii_whitespace() {
            index += 1;
        }
        let (raw, after) = match bytes.get(index) {
            Some(&quote @ (b'"' | b'\'')) => {
                let inner = index + 1;
                let mut escaped = false;
                let close = css[inner..]
                    .char_indices()
                    .find(|&(_, c)| {
                        let ends = !escaped && c == char::from(quote);
                        escaped = !escaped && c == '\\';
                        ends
                    })
                    .map_or(bytes.len(), |(offset, _)| inner + offset);
                let paren = css[close..].find(')').map_or(bytes.len(), |p| close + p + 1);
                (&css[inner..close], paren)
            }
            _ => {
                let close = css[index..].find(')').map_or(bytes.len(), |p| index + p);
                (css[index..close].trim(), (close + 1).min(bytes.len()))
            }
        };
        at = after.max(at);
        if names_image(&css[..start]) {
            found.push(CssUrl {
                start,
                end: after,
                url: unescape(raw),
            });
        }
    }
    found
}

/// False when the declaration or rule a url sits in, which `before` ends with, is `@import` or `src:`.
fn names_image(before: &str) -> bool {
    let from = before.rfind([';', '{', '}']).map_or(0, |index| index + 1);
    let lead = before[from..].trim_start().to_ascii_lowercase();
    let property = lead.split(':').next().unwrap_or_default().trim();
    !(lead.starts_with('@') || property == "src")
}

/// Undoes CSS escapes: a backslash and up to six hex digits (and one space after) is that
/// code point, and a backslash before any other character is that character.
fn unescape(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut chars = raw.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        let mut hex = String::new();
        while hex.len() < 6 && chars.peek().is_some_and(char::is_ascii_hexdigit) {
            hex.extend(chars.next());
        }
        if hex.is_empty() {
            out.extend(chars.next());
            continue;
        }
        if chars.peek().is_some_and(|c| c.is_ascii_whitespace()) {
            chars.next();
        }
        let code = u32::from_str_radix(&hex, 16).ok().and_then(char::from_u32);
        out.push(code.unwrap_or('\u{fffd}'));
    }
    out
}

/// `css` with each span `css_urls` found, in order, replaced: (start, end, replacement).
pub fn replace(css: &str, changes: &[(usize, usize, String)]) -> String {
    let mut out = String::with_capacity(css.len());
    let mut from = 0;
    for (start, end, replacement) in changes {
        out.push_str(&css[from..*start]);
        out.push_str(replacement);
        from = *end;
    }
    out.push_str(&css[from..]);
    out
}
