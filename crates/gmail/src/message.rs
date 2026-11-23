//! A Gmail message as the core's facts and body. Facts come from `format=metadata`
//! (headers, snippet, size, date). Bodies come from `format=full`, whose payload is the
//! parsed MIME tree with each part's content as base64url.
//! https://developers.google.com/gmail/api/reference/rest/v1/users.messages

use base64::Engine;
use base64::alphabet::URL_SAFE;
use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
use chrono::{DateTime, SecondsFormat};
use letterbox_core::adapter::{RemoteAddress, RemoteAttachment, RemoteBody, RemoteFacts, RemoteHeaders, RemoteMessage};

use crate::labels;
use crate::wire::{Message, Part};

/// The headers `format=metadata` is asked for. Gmail returns only these.
pub const METADATA_HEADERS: [&str; 14] = [
    "From",
    "To",
    "Cc",
    "Subject",
    "Date",
    "Message-ID",
    "In-Reply-To",
    "References",
    "List-Unsubscribe",
    "List-Unsubscribe-Post",
    "List-Id",
    "Precedence",
    "Auto-Submitted",
    "Content-Type",
];

/// The first value of a header, by case-insensitive name.
fn header<'a>(message: &'a Message, name: &str) -> Option<&'a str> {
    let headers = message
        .payload
        .as_ref()
        .map(|payload| payload.headers.as_slice())
        .unwrap_or_default();
    headers
        .iter()
        .find(|header| header.name.eq_ignore_ascii_case(name))
        .map(|header| header.value.trim())
}

/// Every `<id>` in a header, without the angle brackets.
fn message_ids(value: &str) -> impl Iterator<Item = String> + '_ {
    value
        .split('<')
        .skip(1)
        .filter_map(|rest| rest.split_once('>').map(|(id, _)| id.trim().to_owned()))
        .filter(|id| !id.is_empty())
}

/// An address header's value with each comment (RFC 5322 section 3.2.2), parenthesized text
/// outside a quoted string that may nest and escape a character with a backslash, made one
/// space. A comment is not part of any address, so `x@shop.example (<y@evil.example>)` is
/// shop.example's, and it separates words as space does (section 3.2.3), so
/// `Jane(comment)Doe` is Jane Doe.
fn without_comments(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let (mut depth, mut quoted, mut escaped) = (0_u32, false, false);
    for c in value.chars() {
        let in_comment = depth > 0;
        match c {
            _ if escaped => escaped = false,
            '\\' if quoted || in_comment => escaped = true,
            '"' if !in_comment => quoted = !quoted,
            '(' if !quoted => depth += 1,
            ')' if in_comment => depth -= 1,
            _ => {}
        }
        // A quoted string is kept whole. Outside one, a comment and its parentheses become one space.
        let kept = quoted || !in_comment && depth == 0 && c != ')';
        if kept {
            out.push(c);
        } else if in_comment && depth == 0 {
            out.push(' ');
        }
    }
    out
}

/// Splits an address list on the commas between addresses, not those inside quotes or angle brackets.
fn split_addresses(value: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let (mut start, mut quoted, mut angled) = (0, false, false);
    let mut escaped = false;
    for (index, char) in value.char_indices() {
        match char {
            _ if escaped => escaped = false,
            '\\' if quoted => escaped = true,
            '"' => quoted = !quoted,
            '<' if !quoted => angled = true,
            '>' if !quoted => angled = false,
            ',' if !quoted && !angled => {
                parts.push(&value[start..index]);
                start = index + 1;
            }
            _ => {}
        }
    }
    parts.push(&value[start..]);
    parts
        .into_iter()
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .collect()
}

/// A mailbox as written, without the space a comment or folding left in it. Space outside a
/// quoted string is never part of an address. Inside one, as in `"first last"@example.com`,
/// it is, so it stays.
fn mailbox(text: &str) -> String {
    let (mut quoted, mut escaped) = (false, false);
    text.chars()
        .filter(|&c| {
            let kept = quoted || !c.is_whitespace();
            match c {
                _ if escaped => escaped = false,
                '\\' if quoted => escaped = true,
                '"' => quoted = !quoted,
                _ => {}
            }
            kept
        })
        .collect()
}

/// One `Name <address>` or bare address. Encoded words (RFC 2047) are left as they are.
fn address(text: &str) -> RemoteAddress {
    // The angle bracket that opens the address is the first one outside a quoted display name,
    // so `"Shop <news@shop.example>" <x@evil.example>` is evil.example's.
    let (mut quoted, mut escaped) = (false, false);
    let open = text.char_indices().find_map(|(index, c)| {
        match c {
            _ if escaped => escaped = false,
            '\\' if quoted => escaped = true,
            '"' => quoted = !quoted,
            '<' if !quoted => return Some(index),
            _ => {}
        }
        None
    });
    let Some((name, rest)) = open.map(|index| (&text[..index], &text[index + 1..])) else {
        return RemoteAddress {
            name: None,
            address: mailbox(text),
        };
    };
    let address = mailbox(rest.split_once('>').map_or(rest, |(address, _)| address));
    let name = name.trim();
    // A quoted name is the sender's own text. Any other has its runs of space made one, which
    // includes the space a comment left.
    let name = name
        .strip_prefix('"')
        .and_then(|inner| inner.strip_suffix('"'))
        .map_or_else(
            || name.split_whitespace().collect::<Vec<_>>().join(" "),
            |inner| inner.replace("\\\"", "\"").replace("\\\\", "\\"),
        );
    RemoteAddress {
        name: (!name.is_empty()).then_some(name),
        address,
    }
}

fn addresses(message: &Message, name: &str) -> Vec<RemoteAddress> {
    let value = header(message, name).map(without_comments);
    value
        .as_deref()
        .map(split_addresses)
        .unwrap_or_default()
        .into_iter()
        .map(address)
        .collect()
}

/// Undoes the HTML escaping Gmail applies to snippets: `&amp;`, `&#39;` and the like.
fn unescape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        rest = &rest[at..];
        let entity = rest.find(';').filter(|end| *end <= 10).map(|end| &rest[1..end]);
        let char = entity.and_then(|entity| match entity {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            "nbsp" => Some(' '),
            _ => entity
                .strip_prefix("#x")
                .or_else(|| entity.strip_prefix("#X"))
                .and_then(|hex| u32::from_str_radix(hex, 16).ok())
                .or_else(|| entity.strip_prefix('#').and_then(|decimal| decimal.parse().ok()))
                .and_then(char::from_u32),
        });
        match (char, entity) {
            (Some(char), Some(entity)) => {
                out.push(char);
                rest = &rest[entity.len() + 2..];
            }
            _ => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// When the message was sent, as the core's time format. `internalDate` is when Gmail
/// accepted the message, which the reference calls more trustworthy than the Date header.
fn sent_at(message: &Message) -> String {
    let from_internal = message
        .internal_date
        .as_deref()
        .and_then(|ms| ms.parse().ok())
        .and_then(DateTime::from_timestamp_millis);
    let from_header = || {
        header(message, "Date")
            .and_then(|date| DateTime::parse_from_rfc2822(date).ok())
            .map(|date| date.to_utc())
    };
    from_internal
        .or_else(from_header)
        .unwrap_or_default()
        .to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// A message fetched with `format=metadata`, as the core lists it.
pub fn remote_message(message: &Message) -> RemoteMessage {
    let has = |name| header(message, name).is_some();
    let value = |name| header(message, name).unwrap_or_default().to_owned();
    let mut references: Vec<String> = Vec::new();
    for id in message_ids(&value("References")).chain(message_ids(&value("In-Reply-To"))) {
        if !references.contains(&id) {
            references.push(id);
        }
    }
    let from = addresses(message, "From").into_iter().next().unwrap_or(RemoteAddress {
        name: None,
        address: String::new(),
    });
    RemoteMessage {
        state: labels::state(&message.id, &message.label_ids),
        facts: RemoteFacts {
            message_id: message_ids(&value("Message-ID")).next(),
            references,
            subject: value("Subject"),
            from,
            to: addresses(message, "To"),
            cc: addresses(message, "Cc"),
            sent_at: sent_at(message),
            // Gmail builds the snippet itself and may keep quoted text the core's other providers drop.
            preview: unescape(&message.snippet).chars().take(200).collect(),
            size: message.size_estimate,
            // Attachments travel in a multipart/mixed message. The metadata format has no parts to look at.
            has_attachments: value("Content-Type")
                .to_ascii_lowercase()
                .starts_with("multipart/mixed"),
            headers: RemoteHeaders {
                list_unsubscribe: has("List-Unsubscribe"),
                list_id: has("List-Id"),
                precedence: value("Precedence"),
                auto_submitted: value("Auto-Submitted"),
                list_unsubscribe_value: value("List-Unsubscribe"),
                list_unsubscribe_post: value("List-Unsubscribe-Post"),
            },
            bulk: labels::bulk(&message.label_ids),
        },
    }
}

/// Decodes base64url content, with or without padding.
pub fn decode_bytes(data: &str) -> Vec<u8> {
    let engine = GeneralPurpose::new(
        &URL_SAFE,
        GeneralPurposeConfig::new().with_decode_padding_mode(DecodePaddingMode::Indifferent),
    );
    engine.decode(data.trim()).unwrap_or_default()
}

/// Decodes a part's base64url content as UTF-8.
fn decode(data: &str) -> String {
    String::from_utf8_lossy(&decode_bytes(data)).into_owned()
}

/// Walks the MIME tree for the body: the first text/plain and text/html parts. A part with
/// a filename is an attachment (see `attachment_parts`), so the walk does not enter it.
fn walk(part: &Part, html: &mut Option<String>, text: &mut Option<String>) {
    if !part.filename.is_empty() {
        return;
    }
    let mime = part.mime_type.to_ascii_lowercase();
    let data = part.body.data.as_deref();
    match (mime.as_str(), data) {
        ("text/plain", Some(data)) if text.is_none() => *text = Some(decode(data)),
        ("text/html", Some(data)) if html.is_none() => *html = Some(decode(data)),
        _ => {}
    }
    for child in &part.parts {
        walk(child, html, text);
    }
}

/// Every part with a filename, in tree order: the attachments, in the order the body lists
/// them, so an attachment's place there finds its part here too.
fn attachment_parts<'a>(part: &'a Part, found: &mut Vec<&'a Part>) {
    if !part.filename.is_empty() {
        return found.push(part);
    }
    for child in &part.parts {
        attachment_parts(child, found);
    }
}

/// The part of the attachment at `index` in a message fetched with `format=full`, if any.
pub fn attachment_part(message: &Message, index: usize) -> Option<&Part> {
    let mut found = Vec::new();
    if let Some(payload) = &message.payload {
        attachment_parts(payload, &mut found);
    }
    found.get(index).copied()
}

/// A message fetched with `format=full`, as the core opens it.
pub fn remote_body(message: &Message) -> RemoteBody {
    let (mut html, mut text) = (None, None);
    let mut parts = Vec::new();
    if let Some(payload) = &message.payload {
        walk(payload, &mut html, &mut text);
        attachment_parts(payload, &mut parts);
    }
    let attachments = parts.into_iter().map(|part| {
        let disposition = part
            .headers
            .iter()
            .find(|header| header.name.eq_ignore_ascii_case("Content-Disposition"))
            .map(|header| header.value.trim().to_ascii_lowercase())
            .unwrap_or_default();
        RemoteAttachment {
            name: part.filename.clone(),
            mime: part.mime_type.to_ascii_lowercase(),
            size: part.body.size,
            inline: disposition.starts_with("inline"),
        }
    });
    RemoteBody {
        text: text.unwrap_or_default(),
        html,
        attachments: attachments.collect(),
    }
}
