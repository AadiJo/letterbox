//! Turns a draft into a message the core can send: checks it, writes it (see mime.rs), and
//! works out the facts and body its outbox message shows until the provider holds it.
//!
//! A forward is written here whole but for its attachments. The original's text follows the
//! user's under a "Forwarded message" block, in the form Gmail writes, in the text and, when
//! either side has HTML, in an HTML part too. The HTML part shows the block and the original's
//! HTML plainly, not as a quote a reader would fold away. The attachments are listed on the
//! outbox message at once, and their content joins the message only when it goes out (outbox.rs).

use chrono::SubsecRound;
use letterbox_protocol::{AccountId, BlobId, Draft, MessageId, Refusal, Role, Time};

use crate::adapter::{BodyResult, RemoteAddress, RemoteAttachment, RemoteBody, RemoteFacts, RemoteHeaders};
use crate::clock::{iso, parse};
use crate::forward::Forward;
use crate::mime::{Letter, Threading, is_plain_address, write};
use crate::world::{MessageRecord, MessageState, World, blob_id_of};

/// A send that passed every check, ready to store.
pub struct Prepared {
    pub account_id: AccountId,
    pub facts: RemoteFacts,
    pub body: RemoteBody,
    pub server: MessageState,
    pub raw: String,
    pub bcc: Vec<String>,
    pub header_id: String,
    pub forward: Option<Forward>,
}

/// The line Gmail opens a forwarded message with, nine dashes on the right.
const FORWARDED: &str = "---------- Forwarded message ---------";

/// The original of a forward and its body, or why it cannot be forwarded.
fn original<'a>(
    world: &'a World,
    account_id: &AccountId,
    id: &MessageId,
) -> Result<(&'a MessageRecord, &'a RemoteBody), Refusal> {
    let record = world.messages.get(id).filter(|record| record.account_id == *account_id);
    let record = record.ok_or(Refusal::UnknownTarget)?;
    match &record.body {
        Some(BodyResult::Body { body }) => Ok((record, body)),
        Some(BodyResult::Gone) => Err(Refusal::UnknownTarget),
        // It loads while its conversation is open, so the user can forward once it shows.
        None => Err(Refusal::Conflict),
    }
}

/// The places among the original's files of those named in `without`, by the blob id each
/// shows under. A name the original does not carry is refused `invalid`.
fn left_out(record: &MessageRecord, body: &RemoteBody, without: &[BlobId]) -> Result<Vec<usize>, Refusal> {
    let place = |blob: &BlobId| (0..body.attachments.len()).find(|&index| blob_id_of(&record.id, index) == *blob);
    without.iter().map(|blob| place(blob).ok_or(Refusal::Invalid)).collect()
}

/// The lines of the block above a forwarded message: who sent it, when, its subject and who got it.
fn forwarded_lines(facts: &RemoteFacts) -> Vec<String> {
    let who = |address: &RemoteAddress| match &address.name {
        Some(name) => format!("{name} <{}>", address.address),
        None => format!("<{}>", address.address),
    };
    let list = |addresses: &[RemoteAddress]| addresses.iter().map(who).collect::<Vec<_>>().join(", ");
    let mut lines = vec![
        FORWARDED.to_owned(),
        format!("From: {}", who(&facts.from)),
        format!("Date: {}", parse(&facts.sent_at).to_rfc2822()),
        format!("Subject: {}", facts.subject),
    ];
    if !facts.to.is_empty() {
        lines.push(format!("To: {}", list(&facts.to)));
    }
    if !facts.cc.is_empty() {
        lines.push(format!("Cc: {}", list(&facts.cc)));
    }
    lines
}

/// Plain text as HTML: escaped, with its line breaks kept.
fn html_of(text: &str) -> String {
    let escaped = text
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;");
    escaped.replace('\n', "<br>\n")
}

/// The text and HTML of a forward: what the user wrote, then the original under its block.
/// It has HTML when the user's draft or the original does.
fn forwarded(written: &str, html: Option<&str>, facts: &RemoteFacts, body: &RemoteBody) -> (String, Option<String>) {
    let lines = forwarded_lines(facts);
    let block = lines.join("\n");
    let original = body.text.replace("\r\n", "\n");
    let text = if written.is_empty() {
        format!("{block}\n\n{original}")
    } else {
        format!("{written}\n\n{block}\n\n{original}")
    };
    if html.is_none() && body.html.is_none() {
        return (text, None);
    }
    let mine = html.map_or_else(|| html_of(written), str::to_owned);
    let gap = if mine.is_empty() { "" } else { "<br><br>\n" };
    let theirs = body.html.clone().unwrap_or_else(|| html_of(&original));
    let attribution = lines
        .iter()
        .map(|line| html_of(line))
        .collect::<Vec<_>>()
        .join("<br>\n");
    let html = format!("{mine}{gap}<div><div dir=\"ltr\">{attribution}<br></div><br>\n{theirs}</div>\n");
    (text, Some(html))
}

/// The start of the text as a list row shows it: no quoted lines, single spaces, at most
/// 200 characters. The sim provider's `previewOf` gives the same for the copy it keeps.
fn preview_of(text: &str) -> String {
    let kept: Vec<&str> = text.lines().filter(|line| !line.starts_with('>')).collect();
    kept.join(" ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(200)
        .collect()
}

/// Checks a draft and writes its message, or says why it cannot be sent.
pub fn prepare(world: &World, draft: &Draft, now: &Time, random: u64) -> Result<Prepared, Refusal> {
    let account = world.accounts.get(&draft.account_id).ok_or(Refusal::UnknownTarget)?;
    if !account.capabilities.modify {
        return Err(Refusal::NotPermitted);
    }
    if !account.capabilities.send {
        return Err(Refusal::NotSupported);
    }
    let everyone = draft.to.iter().chain(&draft.cc).chain(&draft.bcc);
    if draft.to.is_empty() && draft.cc.is_empty() && draft.bcc.is_empty() {
        return Err(Refusal::Invalid);
    }
    if !everyone.clone().all(|address| is_plain_address(address)) || draft.subject.contains(['\r', '\n']) {
        return Err(Refusal::Invalid);
    }
    if draft.in_reply_to.is_some() && draft.forward_of.is_some() {
        return Err(Refusal::Invalid);
    }
    let parent = match &draft.in_reply_to {
        None => None,
        Some(id) => {
            let parent = world.messages.get(id).filter(|parent| parent.account_id == account.id);
            Some(parent.ok_or(Refusal::UnknownTarget)?)
        }
    };
    let threading = parent.map_or_else(Threading::default, |parent| {
        Threading::of(&parent.facts.references, parent.facts.message_id.as_deref())
    });
    // A Date header holds whole seconds, so the facts keep the same time the header says.
    let date = parse(now).trunc_subsecs(0);
    let domain = account
        .address
        .rsplit_once('@')
        .map_or("letterbox.invalid", |(_, domain)| domain);
    let header_id = format!("{}.{random:016x}@{domain}", date.timestamp_millis());
    let text = draft.text.replace("\r\n", "\n");
    let forwarding = match &draft.forward_of {
        None => None,
        Some(id) => Some(original(world, &account.id, id)?),
    };
    let (text, html) = match forwarding {
        None => (text, draft.html.clone()),
        Some((record, body)) => forwarded(&text, draft.html.as_deref(), &record.facts, body),
    };
    let forward = match forwarding {
        None if draft.forward_without.is_some() => return Err(Refusal::Invalid),
        None => None,
        Some((record, body)) => Some(Forward {
            of: record.id.clone(),
            files: body.attachments.clone(),
            left_out: left_out(record, body, draft.forward_without.as_deref().unwrap_or_default())?,
        }),
    };
    let files: Vec<RemoteAttachment> = forward
        .iter()
        .flat_map(Forward::carried)
        .map(|(_, file)| file.clone())
        .collect();
    let raw = write(&Letter {
        from: &account.address,
        to: &draft.to,
        cc: &draft.cc,
        subject: &draft.subject,
        date,
        message_id: &header_id,
        threading: &threading,
        text: &text,
        html: html.as_deref(),
        forwards: forwarding.and_then(|(record, _)| record.facts.message_id.as_deref()),
    });
    let addresses = |list: &[String]| -> Vec<RemoteAddress> {
        let bare = |address: &String| RemoteAddress {
            name: None,
            address: address.clone(),
        };
        list.iter().map(bare).collect()
    };
    let sent = world
        .mailboxes
        .values()
        .find(|mailbox| mailbox.account_id == account.id && mailbox.role == Some(Role::Sent));
    Ok(Prepared {
        account_id: account.id.clone(),
        facts: RemoteFacts {
            message_id: Some(header_id.clone()),
            references: threading.read_back(),
            subject: draft.subject.clone(),
            from: RemoteAddress {
                name: None,
                address: account.address.clone(),
            },
            to: addresses(&draft.to),
            cc: addresses(&draft.cc),
            sent_at: iso(date),
            preview: preview_of(&text),
            // A guess for a forward until it goes out, when the outbox saves the size it has then.
            size: raw.len() as u64 + files.iter().map(|file| file.size).sum::<u64>(),
            has_attachments: !files.is_empty(),
            headers: RemoteHeaders {
                list_unsubscribe: false,
                list_id: false,
                precedence: String::new(),
                auto_submitted: String::new(),
                list_unsubscribe_value: String::new(),
                list_unsubscribe_post: String::new(),
            },
            bulk: None,
        },
        body: RemoteBody {
            text,
            html,
            attachments: files,
        },
        server: MessageState {
            mailboxes: sent.map(|mailbox| mailbox.id.clone()).into_iter().collect(),
            unread: false,
            flagged: false,
        },
        raw,
        bcc: draft.bcc.clone(),
        header_id,
        forward,
    })
}
