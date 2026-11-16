//! Turns a draft into a message the core can send: checks it, writes it (see mime.rs), and
//! works out the facts and body its outbox message shows until the provider holds it.

use chrono::SubsecRound;
use letterbox_protocol::{AccountId, Draft, Refusal, Role, Time};

use crate::adapter::{RemoteAddress, RemoteBody, RemoteFacts, RemoteHeaders};
use crate::clock::{iso, parse};
use crate::mime::{Letter, Threading, is_plain_address, write};
use crate::world::{MessageState, World};

/// A send that passed every check, ready to store.
pub struct Prepared {
    pub account_id: AccountId,
    pub facts: RemoteFacts,
    pub body: RemoteBody,
    pub server: MessageState,
    pub raw: String,
    pub bcc: Vec<String>,
    pub header_id: String,
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
    let raw = write(&Letter {
        from: &account.address,
        to: &draft.to,
        cc: &draft.cc,
        subject: &draft.subject,
        date,
        message_id: &header_id,
        threading: &threading,
        text: &text,
        html: draft.html.as_deref(),
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
            size: raw.len() as u64,
            has_attachments: false,
            headers: RemoteHeaders {
                list_unsubscribe: false,
                list_id: false,
                precedence: String::new(),
                auto_submitted: String::new(),
            },
            bulk: None,
        },
        body: RemoteBody {
            text,
            html: draft.html.clone(),
            attachments: Vec::new(),
        },
        server: MessageState {
            mailboxes: sent.map(|mailbox| mailbox.id.clone()).into_iter().collect(),
            unread: false,
            flagged: false,
        },
        raw,
        bcc: draft.bcc.clone(),
        header_id,
    })
}
