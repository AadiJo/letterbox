//! Where to unsubscribe from the list a message came from. The core reads it and never acts
//! on it: a mailto send or a POST to the sender's URL tells the sender the address is read.
//!
//! The core picks one way:
//!   1. one-click: the first https URL in List-Unsubscribe, when List-Unsubscribe-Post is
//!      `List-Unsubscribe=One-Click` (RFC 8058). It is marked unverified: RFC 8058 asks for a
//!      DKIM signature over both headers before a POST, which the core does not check yet.
//!   2. else the first mailto or https URI in List-Unsubscribe, in the header's own order
//!      (RFC 2369 lists them in the sender's order of preference),
//!   3. else a link in the body before its quote (see `Link`): in HTML an `<a>` with an https
//!      `href`, the first whose text says "unsubscribe", else the first whose `href` does; in
//!      plain text, the first https URL on a line that says "unsubscribe", or on the line after it.
//!
//! List-Unsubscribe is read as RFC 2369 section 2 writes it: URIs in angle brackets, separated
//! by commas, with space and parenthesized comments between them. Reading stops at the first
//! entry that is not in brackets. http URLs are left out everywhere.

use letterbox_protocol::{Unsubscribe, UnsubscribeSource};
use url::Url;

use crate::adapter::RemoteHeaders;

/// The way the header names, or None when it names neither a mailto nor an https URI.
pub fn from_headers(headers: &RemoteHeaders) -> Option<Unsubscribe> {
    let urls: Vec<Url> = entries(&headers.list_unsubscribe_value)
        .into_iter()
        .filter_map(|entry| Url::parse(entry).ok())
        .filter(|url| matches!(url.scheme(), "https" | "mailto"))
        .collect();
    let one_click = headers
        .list_unsubscribe_post
        .trim()
        .eq_ignore_ascii_case("List-Unsubscribe=One-Click");
    if one_click && let Some(url) = urls.iter().find(|url| url.scheme() == "https") {
        return Some(Unsubscribe::OneClick {
            url: url.to_string(),
            verified: false,
        });
    }
    let first = urls.first()?;
    Some(match first.scheme() {
        "mailto" => Unsubscribe::Mailto {
            to: first.path().to_owned(),
            uri: first.to_string(),
        },
        _ => Unsubscribe::Web {
            url: first.to_string(),
            from: UnsubscribeSource::Header,
        },
    })
}

/// The URIs in a List-Unsubscribe value, in order, read as RFC 2369 section 2 writes them.
fn entries(value: &str) -> Vec<&str> {
    let mut found = Vec::new();
    let mut rest = skip_space(value);
    while let Some(inner) = rest.strip_prefix('<') {
        let Some((entry, after)) = inner.split_once('>') else {
            break;
        };
        found.push(entry.trim());
        match skip_space(after).strip_prefix(',') {
            Some(next) => rest = skip_space(next),
            None => break,
        }
    }
    found
}

/// `text` without the space and comments it starts with. A comment is in parentheses, may
/// nest, and may escape a character with a backslash (RFC 5322 section 3.2.2).
fn skip_space(text: &str) -> &str {
    let mut rest = text.trim_start();
    while rest.starts_with('(') {
        let mut depth = 0_u32;
        let mut escaped = false;
        let end = rest.char_indices().find_map(|(index, c)| {
            match c {
                _ if escaped => escaped = false,
                '\\' => escaped = true,
                '(' => depth += 1,
                ')' => {
                    depth -= 1;
                    if depth == 0 {
                        return Some(index + 1);
                    }
                }
                _ => {}
            }
            None
        });
        match end {
            Some(end) => rest = rest[end..].trim_start(),
            None => return "",
        }
    }
    rest
}

/// How well an `<a>` in an HTML body looks like an unsubscribe link.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Link {
    /// Its href says unsubscribe.
    Href,
    /// Its text says unsubscribe.
    Text,
}

/// How an `<a>` with this `href` (entities decoded) and text looks, if it is an https link that says unsubscribe.
pub fn link(href: &str, text: &str) -> Option<Link> {
    let url = Url::parse(href.trim()).ok().filter(|url| url.scheme() == "https")?;
    if says_unsubscribe(text) {
        Some(Link::Text)
    } else {
        says_unsubscribe(url.as_str()).then_some(Link::Href)
    }
}

fn says_unsubscribe(text: &str) -> bool {
    text.to_ascii_lowercase().contains("unsubscribe")
}

/// The first https URL on a line of `text` that says unsubscribe, or on the next line that is not blank.
pub fn link_in_text(text: &str) -> Option<String> {
    let lines: Vec<&str> = text.lines().collect();
    for (index, line) in lines.iter().enumerate() {
        if !says_unsubscribe(line) {
            continue;
        }
        let next = lines[index + 1..].iter().find(|line| !line.trim().is_empty());
        if let Some(url) = first_url(line).or_else(|| next.and_then(|line| first_url(line))) {
            return Some(url);
        }
    }
    None
}

/// The first https URL in a line of plain text, without the punctuation that often ends a sentence or wraps a link.
fn first_url(line: &str) -> Option<String> {
    let at = line.find("https://")?;
    let rest = &line[at..];
    let end = rest
        .find(|c: char| c.is_whitespace() || matches!(c, '<' | '>' | '"' | '\'' | ')' | ']'))
        .unwrap_or(rest.len());
    let candidate = rest[..end].trim_end_matches(['.', ',', ';', ':']);
    Url::parse(candidate).ok().map(|url| url.to_string())
}
