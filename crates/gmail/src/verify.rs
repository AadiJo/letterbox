//! Whether Google verified that a message's From domain sent it, for "always show images from
//! this sender" (crates/core/src/body/mod.rs). The answer is false whenever anything about it is
//! uncertain.
//!
//! The headers come from the message as written (`format=raw`), not from `format=metadata`,
//! whose header order and authorship Gmail does not document. In the raw message, headers are
//! in their real order: each server that handles a message adds its own above the ones it
//! received, so the header Google's receiving server writes sits above every header the sender
//! wrote. Only the start of the raw message is read (`RAW_PREFIX`), enough for its headers.
//!
//! A message is verified when all of these hold:
//!   1. it has exactly one From header, naming exactly one mailbox (RFC 5322, with quoted
//!      strings and comments read as such), with a domain,
//!   2. its first Authentication-Results header (RFC 8601) names Google's authserv-id,
//!      mx.google.com, and says `dmarc=pass` with `header.from` that domain (RFC 7489),
//!   3. no other Authentication-Results header that names mx.google.com says otherwise.
//!
//! How sure that is: Gmail writes its verdict for mail it receives, above the sender's headers,
//! and a sender can add headers but not remove Google's. So a forged pass sits below a real
//! fail (rule 2), or beside it (rule 3). What is left: a message that reached the mailbox
//! without passing Google's receiving server, as one imported or inserted through the API can,
//! carries no verdict of Google's, and a header its author wrote at the top would read as one.

use base64::Engine;
use base64::alphabet::URL_SAFE;
use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};

/// How much of a `format=raw` answer is read for the headers. Headers past it leave the message unverified.
pub const RAW_PREFIX: usize = 256 * 1024;

/// Google's authserv-id in the Authentication-Results it writes.
const GOOGLE: &str = "mx.google.com";

/// True when the start of a `format=raw` answer shows a message Google verified (see above).
pub fn verified(prefix: &[u8]) -> bool {
    headers(prefix).is_some_and(|headers| verdict(&headers))
}

fn verdict(headers: &[(String, String)]) -> bool {
    fn named<'a>(headers: &'a [(String, String)], name: &'static str) -> impl Iterator<Item = &'a str> {
        headers
            .iter()
            .filter(move |(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }
    let froms: Vec<&str> = named(headers, "From").collect();
    let [from] = froms.as_slice() else {
        return false;
    };
    let Some(domain) = sole_mailbox_domain(from) else {
        return false;
    };
    let mut results = named(headers, "Authentication-Results");
    let Some(first) = results.next() else {
        return false;
    };
    let says_pass = |value: &str| by_google(value) && dmarc_pass(value, &domain);
    says_pass(first) && results.filter(|value| by_google(value)).all(says_pass)
}

/// True when an Authentication-Results value names Google's authserv-id.
fn by_google(value: &str) -> bool {
    let id = value.split(';').next().and_then(|id| id.split_whitespace().next());
    id.is_some_and(|id| id.eq_ignore_ascii_case(GOOGLE))
}

/// True when one of the value's results is `dmarc=pass` with `header.from=<domain>`.
fn dmarc_pass(value: &str, domain: &str) -> bool {
    value.split(';').skip(1).any(|result| {
        let words: Vec<&str> = result.split_whitespace().collect();
        let passed = words
            .first()
            .is_some_and(|word| word.eq_ignore_ascii_case("dmarc=pass"));
        passed
            && words.iter().any(|word| {
                word.strip_prefix("header.from=")
                    .is_some_and(|named| named.eq_ignore_ascii_case(domain))
            })
    })
}

/// The headers of a raw message, in order and unfolded, from the start of its `format=raw`
/// answer. None when the answer holds no `raw` field, or its headers do not end within it.
fn headers(prefix: &[u8]) -> Option<Vec<(String, String)>> {
    let text = std::str::from_utf8(prefix)
        .unwrap_or_else(|error| std::str::from_utf8(&prefix[..error.valid_up_to()]).unwrap_or_default());
    let key = text.find("\"raw\"")?;
    let rest = text[key + 5..]
        .trim_start()
        .strip_prefix(':')?
        .trim_start()
        .strip_prefix('"')?;
    let encoded: String = rest
        .chars()
        .take_while(|c| *c != '"')
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '='))
        .collect();
    let whole = encoded.len() - encoded.len() % 4;
    let engine = GeneralPurpose::new(
        &URL_SAFE,
        GeneralPurposeConfig::new().with_decode_padding_mode(DecodePaddingMode::Indifferent),
    );
    let decoded = engine.decode(&encoded[..whole]).ok()?;
    let message = String::from_utf8_lossy(&decoded);
    let end = message.find("\r\n\r\n").or_else(|| message.find("\n\n"))?;
    let mut headers: Vec<(String, String)> = Vec::new();
    for line in message[..end].lines() {
        if line.starts_with([' ', '\t']) {
            let (_, value) = headers.last_mut()?;
            value.push(' ');
            value.push_str(line.trim());
        } else {
            let (name, value) = line.split_once(':')?;
            headers.push((name.trim().to_owned(), value.trim().to_owned()));
        }
    }
    Some(headers)
}

/// The lowercase domain of the one mailbox a From value names (RFC 5322 section 3.4), or None
/// when it names none, more than one, or a group, or cannot be read. Quoted strings and
/// comments are read as such, so `"Bank <x@bank.example>" <x@evil.example>` names evil.example.
pub fn sole_mailbox_domain(value: &str) -> Option<String> {
    // Comments go; quoted strings stay whole. A backslash escapes the next character in either.
    let mut plain = String::new();
    let (mut depth, mut quoted, mut escaped) = (0_u32, false, false);
    for c in value.chars() {
        match c {
            _ if escaped => {
                escaped = false;
                if depth == 0 {
                    plain.push(if quoted { 'x' } else { c });
                }
            }
            '\\' if quoted || depth > 0 => escaped = true,
            '"' if depth == 0 => {
                quoted = !quoted;
                plain.push('"');
            }
            '(' if !quoted => depth += 1,
            ')' if !quoted && depth > 0 => depth -= 1,
            _ if depth > 0 => {}
            // Inside quotes only the quotes matter: what they hold is a display name.
            _ if quoted => plain.push('x'),
            _ => plain.push(c),
        }
    }
    if quoted || depth > 0 || plain.contains([',', ':', ';']) {
        return None;
    }
    let address = match (plain.find('<'), plain.rfind('>')) {
        (Some(open), Some(close)) if open < close => {
            if plain[..open].contains(['<', '>']) || !plain[close + 1..].trim().is_empty() {
                return None;
            }
            &plain[open + 1..close]
        }
        (None, None) => plain.as_str(),
        _ => return None,
    };
    let address = address.trim();
    if address.contains(['<', '>', ' ']) || address.matches('@').count() != 1 {
        return None;
    }
    let (local, domain) = address.split_once('@')?;
    let valid = |c: char| c.is_ascii_alphanumeric() || matches!(c, '.' | '-');
    let domain = domain.trim_end_matches('.');
    if local.is_empty() || domain.is_empty() || !domain.chars().all(valid) {
        return None;
    }
    Some(domain.to_ascii_lowercase())
}
