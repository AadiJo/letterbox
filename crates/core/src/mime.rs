//! Writes the messages the core sends, as RFC 5322 text with MIME (RFC 2045 to 2047). This
//! is the one place the core writes MIME, so every rule about the format lives here:
//!   - Every line ends in CRLF and stays within RFC 5322's 998 characters. Free text and
//!     lists fold to stay within 78. An address or Message-ID that is longer on its own is
//!     bounded instead (`is_plain_address`, `Threading`).
//!   - A header value that is not printable ASCII travels as RFC 2047 encoded words.
//!   - Text parts are UTF-8 in base64, so no body line is too long and none can look like
//!     the boundary, which holds "=_", two characters base64 never writes.
//!   - Addresses are bare ASCII (`is_plain_address`), so they need no quoting or encoding.
//!   - Attachments (`attach`) travel in base64 in a multipart/mixed message after the text,
//!     with their names in RFC 2231 parameters when a quoted string cannot hold them.

use chrono::{DateTime, Utc};

/// Everything one message says. The outbox fills it from a draft.
pub struct Letter<'a> {
    pub from: &'a str,
    pub to: &'a [String],
    pub cc: &'a [String],
    pub subject: &'a str,
    pub date: DateTime<Utc>,
    /// Without angle brackets.
    pub message_id: &'a str,
    /// The messages it answers (see `Threading`).
    pub threading: &'a Threading,
    pub text: &'a str,
    pub html: Option<&'a str>,
    /// The Message-ID of the message this forwards, without angle brackets. It goes in
    /// X-Forwarded-Message-Id, as Thunderbird writes it, and not in References: a forward
    /// does not answer the original, so it starts a conversation of its own. An id too long
    /// for a line of its own (`MAX_FORWARDED`) is left out.
    pub forwards: Option<&'a str>,
}

/// One file `attach` adds to a message.
pub struct File<'a> {
    pub name: &'a str,
    pub mime: &'a str,
    pub inline: bool,
    pub bytes: &'a [u8],
}

const BOUNDARY: &str = "=_letterbox_alternative";
const MIXED: &str = "=_letterbox_mixed";
/// The line that ends the headers every reader of the message sees. `attach` finds the text
/// entity after it. A folded header line starts with a space, so no other line can match.
const MIME_VERSION: &str = "\r\nMIME-Version: 1.0\r\n";
/// The longest parameter value written as one quoted string, and the most characters of an
/// RFC 2231 piece after its name and charset, so each parameter line stays within 78.
const PARAMETER: usize = 60;
const PIECE: usize = 40;
/// The longest header line this writer aims for. RFC 5322 section 2.1.1 asks for 78.
const LINE: usize = 78;
/// The most UTF-8 bytes in one encoded word, so the word stays well inside 75 characters.
const WORD_BYTES: usize = 39;

/// The longest Message-ID the core writes in References, where each id takes a line of its own.
const MAX_REFERENCE: usize = 900;
/// The longest Message-ID that fits on an In-Reply-To line: 998 less `In-Reply-To: <` and `>`.
const MAX_IN_REPLY_TO: usize = 998 - 15;
/// The longest Message-ID that fits on an X-Forwarded-Message-Id line: 998 less
/// `X-Forwarded-Message-Id: <` and `>`. A longer one is left out.
const MAX_FORWARDED: usize = 998 - 26;

/// What a reply says about the messages it answers, as it is written. Message-IDs have no
/// place to fold inside them, so a long one is left out instead: of References past
/// `MAX_REFERENCE`, and of In-Reply-To only when not even a line of its own can hold it. The
/// parent stays in In-Reply-To even when it is too long for References.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Threading {
    /// The parent's Message-ID, without angle brackets.
    pub in_reply_to: Option<String>,
    /// The chain it answers, oldest first, without angle brackets.
    pub references: Vec<String>,
}

impl Threading {
    /// The headers of a reply to a message with Message-ID `parent` that answered `ancestors`.
    pub fn of(ancestors: &[String], parent: Option<&str>) -> Threading {
        let chain = ancestors.iter().map(String::as_str).chain(parent);
        Threading {
            in_reply_to: parent.filter(|id| id.len() <= MAX_IN_REPLY_TO).map(str::to_owned),
            references: chain
                .filter(|id| id.len() <= MAX_REFERENCE)
                .map(str::to_owned)
                .collect(),
        }
    }

    /// The ids a reader takes from these headers, as `RemoteFacts::references` holds them:
    /// References, then In-Reply-To unless References has it already.
    pub fn read_back(&self) -> Vec<String> {
        let parent = self.in_reply_to.iter().filter(|id| !self.references.contains(id));
        self.references.iter().chain(parent).cloned().collect()
    }
}

/// True for an address the core can write as it is: printable ASCII with no spaces, one
/// `@` with text on both sides, none of the characters that would need quoting, and at most
/// the 254 characters RFC 5321 allows a path.
pub fn is_plain_address(address: &str) -> bool {
    if address.len() > 254 {
        return false;
    }
    let Some((local, domain)) = address.split_once('@') else {
        return false;
    };
    let allowed = |c: char| c.is_ascii_graphic() && !"<>()[]\\,;:\"@".contains(c);
    !local.is_empty() && !domain.is_empty() && local.chars().all(allowed) && domain.chars().all(allowed)
}

/// The whole message: its headers, then its body.
pub fn write(letter: &Letter<'_>) -> String {
    let mut out = String::new();
    push(&mut out, "From", letter.from);
    push_list(&mut out, "To", letter.to.iter().map(String::as_str));
    push_list(&mut out, "Cc", letter.cc.iter().map(String::as_str));
    push_unstructured(&mut out, "Subject", letter.subject);
    push(&mut out, "Date", &letter.date.to_rfc2822());
    push(&mut out, "Message-ID", &format!("<{}>", letter.message_id));
    if let Some(parent) = &letter.threading.in_reply_to {
        push(&mut out, "In-Reply-To", &format!("<{parent}>"));
    }
    if !letter.threading.references.is_empty() {
        let ids: Vec<String> = letter.threading.references.iter().map(|id| format!("<{id}>")).collect();
        push(&mut out, "References", &ids.join("\r\n "));
    }
    if let Some(original) = letter.forwards.filter(|id| id.len() <= MAX_FORWARDED) {
        push(&mut out, "X-Forwarded-Message-Id", &format!("<{original}>"));
    }
    push(&mut out, "MIME-Version", "1.0");
    match letter.html {
        None => push_part(&mut out, "text/plain", letter.text),
        Some(html) => {
            push(
                &mut out,
                "Content-Type",
                &format!("multipart/alternative; boundary=\"{BOUNDARY}\""),
            );
            out.push_str("\r\n");
            for (mime, content) in [("text/plain", letter.text), ("text/html", html)] {
                out.push_str(&format!("--{BOUNDARY}\r\n"));
                push_part(&mut out, mime, content);
            }
            out.push_str(&format!("--{BOUNDARY}--\r\n"));
        }
    }
    out
}

/// `raw`, a message `write` wrote, with `files` after its text in a multipart/mixed body.
/// The headers stay as they are, so the Message-ID is the same. `raw` alone when `files` is empty.
pub fn attach(raw: &str, files: &[File<'_>]) -> String {
    if files.is_empty() {
        return raw.to_owned();
    }
    let at = raw
        .find(MIME_VERSION)
        .expect("`write` puts a MIME-Version line in every message")
        + MIME_VERSION.len();
    let (envelope, entity) = raw.split_at(at);
    let mut out = envelope.to_owned();
    push(
        &mut out,
        "Content-Type",
        &format!("multipart/mixed; boundary=\"{MIXED}\""),
    );
    out.push_str("\r\n");
    out.push_str(&format!("--{MIXED}\r\n"));
    out.push_str(entity);
    for file in files {
        out.push_str(&format!("--{MIXED}\r\n"));
        let mut kind = media_type(file.mime);
        push_parameter(&mut kind, "name", file.name);
        push(&mut out, "Content-Type", &kind);
        let mut disposition = (if file.inline { "inline" } else { "attachment" }).to_owned();
        push_parameter(&mut disposition, "filename", file.name);
        push(&mut out, "Content-Disposition", &disposition);
        push(&mut out, "Content-Transfer-Encoding", "base64");
        out.push_str("\r\n");
        push_base64(&mut out, file.bytes);
    }
    out.push_str(&format!("--{MIXED}--\r\n"));
    out
}

/// `mime` as a Content-Type writes it: lowercase `type/subtype` made of RFC 2045 token
/// characters. Anything else, which a provider could hand over, is application/octet-stream.
fn media_type(mime: &str) -> String {
    let token = |part: &str| {
        !part.is_empty()
            && part
                .chars()
                .all(|c| c.is_ascii_graphic() && !"()<>@,;:\\\"/[]?=".contains(c))
    };
    match mime.split_once('/') {
        Some((kind, subtype)) if token(kind) && token(subtype) => mime.to_ascii_lowercase(),
        _ => "application/octet-stream".to_owned(),
    }
}

/// Adds `;` and one parameter on a line of its own: a quoted string when the value is short
/// printable ASCII with nothing to escape, else RFC 2231 pieces of UTF-8 in percent encoding,
/// `name*0*=UTF-8''...`, one per line, which no line length can break.
fn push_parameter(out: &mut String, name: &str, value: &str) {
    let quotable = value.chars().all(|c| matches!(c, ' '..='~') && c != '"' && c != '\\');
    if quotable && value.len() <= PARAMETER {
        return out.push_str(&format!(";\r\n {name}=\"{value}\""));
    }
    let mut pieces: Vec<String> = vec![String::new()];
    for byte in value.bytes() {
        let encoded = if byte.is_ascii_alphanumeric() || b"!#$&+-.^_`|~".contains(&byte) {
            char::from(byte).to_string()
        } else {
            format!("%{byte:02X}")
        };
        if pieces.last().is_some_and(|piece| piece.len() + encoded.len() > PIECE) {
            pieces.push(String::new());
        }
        pieces.last_mut().expect("pieces starts with one").push_str(&encoded);
    }
    for (index, piece) in pieces.iter().enumerate() {
        let charset = if index == 0 { "UTF-8''" } else { "" };
        out.push_str(&format!(";\r\n {name}*{index}*={charset}{piece}"));
    }
}

/// `raw` with a Bcc header in front, or `raw` alone when `bcc` is empty.
pub fn with_bcc(raw: &str, bcc: &[String]) -> String {
    let mut out = String::new();
    push_list(&mut out, "Bcc", bcc.iter().map(String::as_str));
    out.push_str(raw);
    out
}

fn push(out: &mut String, name: &str, value: &str) {
    out.push_str(name);
    out.push_str(": ");
    out.push_str(value);
    out.push_str("\r\n");
}

/// An address list, one address per line. Nothing when the list is empty.
fn push_list<'a>(out: &mut String, name: &str, addresses: impl Iterator<Item = &'a str>) {
    let joined = addresses.collect::<Vec<_>>().join(",\r\n ");
    if !joined.is_empty() {
        push(out, name, &joined);
    }
}

/// A free-text header such as Subject. Printable ASCII folds at its spaces, which unfolding
/// gives back. Anything else becomes encoded words, one per line: text that is not ASCII,
/// text that holds "=?", so a reader cannot mistake it for an encoded word, and text with a
/// word too long to fit on a line, which folding at spaces cannot break.
fn push_unstructured(out: &mut String, name: &str, value: &str) {
    let fits = value.split(' ').all(|word| name.len() + 2 + word.len() <= LINE);
    let plain = value.chars().all(|c| matches!(c, ' '..='~')) && !value.contains("=?") && fits;
    if !plain {
        let words = utf8_chunks(value, WORD_BYTES).map(|chunk| format!("=?UTF-8?B?{}?=", base64(chunk.as_bytes())));
        return push(out, name, &words.collect::<Vec<_>>().join("\r\n "));
    }
    let mut line = format!("{name}:");
    for (index, word) in value.split(' ').enumerate() {
        if index > 0 && line.len() + 1 + word.len() > LINE && line.trim_end().len() > name.len() + 1 {
            out.push_str(&line);
            out.push_str("\r\n");
            line.clear();
        }
        line.push(' ');
        line.push_str(word);
    }
    out.push_str(&line);
    out.push_str("\r\n");
}

/// One text part: its headers, a blank line, then its content in base64 with CRLF line ends.
fn push_part(out: &mut String, mime: &str, content: &str) {
    push(out, "Content-Type", &format!("{mime}; charset=UTF-8"));
    push(out, "Content-Transfer-Encoding", "base64");
    out.push_str("\r\n");
    let canonical = content.replace("\r\n", "\n").replace('\r', "\n").replace('\n', "\r\n");
    push_base64(out, canonical.as_bytes());
}

/// Content in base64, in lines of 76 characters with CRLF line ends (RFC 2045 section 6.8).
fn push_base64(out: &mut String, bytes: &[u8]) {
    let encoded = base64(bytes);
    for line in encoded.as_bytes().chunks(76) {
        out.push_str(std::str::from_utf8(line).expect("base64 is ASCII"));
        out.push_str("\r\n");
    }
}

/// Splits text into pieces of at most `limit` bytes, never inside a character.
fn utf8_chunks(text: &str, limit: usize) -> impl Iterator<Item = &str> {
    let mut rest = text;
    std::iter::from_fn(move || {
        if rest.is_empty() {
            return None;
        }
        let mut end = rest.len().min(limit);
        while !rest.is_char_boundary(end) {
            end -= 1;
        }
        let (chunk, tail) = rest.split_at(end);
        rest = tail;
        Some(chunk)
    })
}

/// Standard base64 with padding (RFC 4648 section 4).
fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for group in bytes.chunks(3) {
        let n = group
            .iter()
            .enumerate()
            .fold(0u32, |n, (index, byte)| n | u32::from(*byte) << (16 - 8 * index));
        for index in 0..4 {
            if index <= group.len() {
                let sextet = (n >> (18 - 6 * index)) & 63;
                out.push(char::from(ALPHABET[sextet as usize]));
            } else {
                out.push('=');
            }
        }
    }
    out
}
