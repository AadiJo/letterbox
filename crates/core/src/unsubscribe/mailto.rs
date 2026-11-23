//! The email a mailto unsubscribe sends, read from its URI as RFC 6068 writes one:
//! `mailto:<address>?subject=<text>&body=<text>`, percent-encoded, where `+` is a plus, not a
//! space. Only the address, the subject and the body are read. Any other field, such as a cc
//! or a second address, is left out, so the email goes to the one address the sender named.

use letterbox_protocol::{AccountId, Draft};
use percent_encoding::percent_decode_str;

/// The subject an unsubscribe email gets when the URI names none.
const SUBJECT: &str = "Unsubscribe";

/// The draft that sends the unsubscribe email `uri` describes, from `account_id`, or None when
/// the URI is not a mailto URI naming one address.
pub fn draft(account_id: &AccountId, uri: &str) -> Option<Draft> {
    let rest = uri.get(..7).filter(|scheme| scheme.eq_ignore_ascii_case("mailto:"))?;
    let rest = &uri[rest.len()..];
    let (to, query) = rest.split_once('?').unwrap_or((rest, ""));
    let to = decoded(to)?;
    if to.is_empty() || to.contains(',') {
        return None;
    }
    let mut subject = None;
    let mut body = None;
    for field in query.split('&') {
        let (name, value) = field.split_once('=').unwrap_or((field, ""));
        let slot = match decoded(name)?.to_ascii_lowercase().as_str() {
            "subject" => &mut subject,
            "body" => &mut body,
            _ => continue,
        };
        slot.get_or_insert(decoded(value)?);
    }
    Some(Draft {
        account_id: account_id.clone(),
        to: vec![to],
        cc: Vec::new(),
        bcc: Vec::new(),
        // A header holds one line, so a subject that asks for more is cut at its first break.
        subject: subject
            .and_then(|subject| subject.lines().next().map(str::to_owned))
            .filter(|subject| !subject.trim().is_empty())
            .unwrap_or_else(|| SUBJECT.to_owned()),
        text: body.unwrap_or_default(),
        html: None,
        in_reply_to: None,
        forward_of: None,
        forward_without: None,
    })
}

/// `text` with its percent-escapes decoded, or None when they do not make UTF-8.
fn decoded(text: &str) -> Option<String> {
    percent_decode_str(text)
        .decode_utf8()
        .ok()
        .map(|text| text.into_owned())
}
