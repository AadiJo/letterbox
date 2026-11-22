//! Where to unsubscribe from the list a message came from. The core reads it and never acts
//! on it: a mailto send or a POST to the sender's URL tells the sender the address is read.
//!
//! The List-Unsubscribe header (RFC 2369) wins: its first `mailto:` URI and its first https
//! URL, with one-click when List-Unsubscribe-Post is `List-Unsubscribe=One-Click` (RFC 8058).
//! Its http URLs are left out, as RFC 8058 allows one-click over https only. Without the
//! header, a link in the body before its quote (see `Link`): in HTML an `<a>` with an https
//! `href`, the first whose text says "unsubscribe", else the first whose `href` does. In
//! plain text, the first https URL on a line that says "unsubscribe", or on the line after it.

use letterbox_protocol::{Unsubscribe, UnsubscribeWeb};
use url::Url;

use crate::adapter::RemoteHeaders;

/// The header's targets, or None when it has neither a mailto nor an https one.
pub fn from_headers(headers: &RemoteHeaders) -> Option<Unsubscribe> {
    let value = &headers.list_unsubscribe_value;
    let entries: Vec<&str> = if value.contains('<') {
        value
            .split('<')
            .skip(1)
            .filter_map(|rest| rest.split_once('>').map(|(entry, _)| entry))
            .collect()
    } else {
        value.split(',').collect()
    };
    let urls: Vec<Url> = entries
        .iter()
        .filter_map(|entry| Url::parse(entry.trim()).ok())
        .collect();
    let mailto = urls.iter().find(|url| url.scheme() == "mailto").map(Url::to_string);
    let one_click = headers
        .list_unsubscribe_post
        .trim()
        .eq_ignore_ascii_case("List-Unsubscribe=One-Click");
    let web = urls
        .iter()
        .find(|url| url.scheme() == "https")
        .map(|url| UnsubscribeWeb {
            url: url.to_string(),
            one_click,
        });
    (mailto.is_some() || web.is_some()).then_some(Unsubscribe::Header { mailto, web })
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
