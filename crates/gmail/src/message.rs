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
pub const METADATA_HEADERS: [&str; 15] = [
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
    "Authentication-Results",
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

/// One `Name <address>` or bare address. Encoded words (RFC 2047) are left as they are.
fn address(text: &str) -> RemoteAddress {
    let Some((name, rest)) = text.split_once('<') else {
        return RemoteAddress {
            name: None,
            address: text.to_owned(),
        };
    };
    let address = rest
        .split_once('>')
        .map_or(rest, |(address, _)| address)
        .trim()
        .to_owned();
    let name = name.trim();
    let name = name
        .strip_prefix('"')
        .and_then(|inner| inner.strip_suffix('"'))
        .map_or_else(
            || name.to_owned(),
            |inner| inner.replace("\\\"", "\"").replace("\\\\", "\\"),
        );
    RemoteAddress {
        name: (!name.is_empty()).then_some(name),
        address,
    }
}

fn addresses(message: &Message, name: &str) -> Vec<RemoteAddress> {
    header(message, name)
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

/// True when Google verified that the From address's domain sent the message: its topmost
/// Authentication-Results header, which Google's receiving server writes, names Google's own
/// authserv-id, mx.google.com, and says `dmarc=pass` with `header.from` that domain (RFC 8601,
/// RFC 7489). A sender can write more of the header, but below Google's, so only the first
/// counts, and one that names another authserv-id proves nothing.
fn sender_verified(message: &Message, from: &str) -> bool {
    let Some(results) = header(message, "Authentication-Results") else {
        return false;
    };
    let Some(domain) = from
        .rsplit_once('@')
        .map(|(_, domain)| domain)
        .filter(|domain| !domain.is_empty())
    else {
        return false;
    };
    let mut parts = results.split(';');
    let authserv = parts
        .next()
        .unwrap_or_default()
        .split_whitespace()
        .next()
        .unwrap_or_default();
    if !authserv.eq_ignore_ascii_case("mx.google.com") {
        return false;
    }
    parts.any(|part| {
        let words: Vec<&str> = part.split_whitespace().collect();
        let passed = words
            .first()
            .is_some_and(|word| word.eq_ignore_ascii_case("dmarc=pass"));
        let names = words.iter().filter_map(|word| word.strip_prefix("header.from="));
        passed && names.into_iter().any(|named| named.eq_ignore_ascii_case(domain))
    })
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
    let sender_verified = sender_verified(message, &from.address);
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
            sender_verified,
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
