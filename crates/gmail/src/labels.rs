//! Labels, both ways. Most labels become mailboxes. UNREAD and STARRED are the `unread`
//! and `flagged` flags. IMPORTANT, CHAT and the CATEGORY_ labels are neither: Gmail sets
//! them itself, and the categories feed `bulk` instead.
//! System labels: https://developers.google.com/gmail/api/guides/labels#system_labels

use letterbox_core::adapter::{MailboxRef, MessageRef, Mutation, RemoteMailbox, RemoteState};
use letterbox_protocol::Role;

use crate::wire::Label;

pub const UNREAD: &str = "UNREAD";
pub const STARRED: &str = "STARRED";

/// System labels that are mailboxes, with the name and role the core shows. Gmail names
/// each system label by its id ("INBOX"), so the adapter supplies a name a person reads.
/// Gmail has no archive mailbox: archiving is taking a message out of INBOX.
const SYSTEM_MAILBOXES: [(&str, &str, Role); 5] = [
    ("INBOX", "Inbox", Role::Inbox),
    ("SENT", "Sent", Role::Sent),
    ("DRAFT", "Drafts", Role::Drafts),
    ("TRASH", "Trash", Role::Trash),
    ("SPAM", "Spam", Role::Spam),
];

/// System labels that are not mailboxes.
const NOT_MAILBOXES: [&str; 4] = [UNREAD, STARRED, "IMPORTANT", "CHAT"];

/// Labels Gmail applies on its own and the user cannot apply by hand, so modify must not
/// name them. The labels guide marks both "no" under "Can be manually applied".
const AUTOMATIC: [&str; 2] = ["SENT", "DRAFT"];

/// The inbox tabs that hold bulk mail. CATEGORY_PERSONAL is the one that does not.
const BULK_CATEGORIES: [&str; 4] = [
    "CATEGORY_PROMOTIONS",
    "CATEGORY_SOCIAL",
    "CATEGORY_UPDATES",
    "CATEGORY_FORUMS",
];

/// True for a label id that names a mailbox, judged by id alone.
fn is_mailbox_id(id: &str) -> bool {
    !NOT_MAILBOXES.contains(&id) && !id.starts_with("CATEGORY_")
}

/// The label as a mailbox, or None for a label that is a flag or a classification.
/// Gmail labels have no parent. A name like "Work/2025" is shown whole.
fn mailbox_of(label: &Label) -> Option<RemoteMailbox> {
    let system = SYSTEM_MAILBOXES.iter().find(|(id, _, _)| *id == label.id);
    let (name, role) = match system {
        Some((_, name, role)) => ((*name).to_owned(), Some(*role)),
        None if label.kind.as_deref() == Some("system") || !is_mailbox_id(&label.id) => return None,
        None => (label.name.clone(), None),
    };
    Some(RemoteMailbox {
        r#ref: MailboxRef::new(&label.id),
        name,
        role,
        parent: None,
    })
}

/// The mailbox list for a list of labels, in Gmail's order.
pub fn mailboxes(labels: &[Label]) -> Vec<RemoteMailbox> {
    labels.iter().filter_map(mailbox_of).collect()
}

/// A short digest of a mailbox list. The cursor keeps it, because history.list does not
/// report label changes: `changes` lists the labels again and compares digests.
pub fn digest(mailboxes: &[RemoteMailbox]) -> String {
    // FNV-1a, 64 bits. Stable across builds and platforms, which a cursor needs.
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for mailbox in mailboxes {
        let parent = mailbox.parent.as_ref().map_or("", MailboxRef::as_str);
        let line = format!(
            "{}\u{1f}{}\u{1f}{:?}\u{1f}{parent}\u{1e}",
            mailbox.r#ref.as_str(),
            mailbox.name,
            mailbox.role
        );
        for byte in line.bytes() {
            hash = (hash ^ u64::from(byte)).wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
    format!("{hash:016x}")
}

/// A message's state from its label ids.
pub fn state(id: &str, label_ids: &[String]) -> RemoteState {
    RemoteState {
        r#ref: MessageRef::new(id),
        mailboxes: label_ids
            .iter()
            .filter(|label| is_mailbox_id(label))
            .map(MailboxRef::new)
            .collect(),
        unread: label_ids.iter().any(|label| label == UNREAD),
        flagged: label_ids.iter().any(|label| label == STARRED),
    }
}

/// Gmail's own bulk verdict, read from the inbox tab it filed the message under. None
/// when the message has no tab, as with mail the user sent.
pub fn bulk(label_ids: &[String]) -> Option<bool> {
    let category = label_ids.iter().find(|label| label.starts_with("CATEGORY_"))?;
    Some(BULK_CATEGORIES.contains(&category.as_str()))
}

/// The label ids to add and remove for one mutation. Values are absolute, so applying the
/// same edit twice leaves the same labels (rule 6). Trash is "add TRASH", which modify
/// accepts: the labels guide marks TRASH as manually applicable, so no trash call is needed.
pub fn edits(mutation: &Mutation) -> (Vec<String>, Vec<String>) {
    let mut add = Vec::new();
    let mut remove = Vec::new();
    match mutation {
        Mutation::Flags { unread, flagged, .. } => {
            for (value, label) in [(unread, UNREAD), (flagged, STARRED)] {
                match value {
                    Some(true) => add.push(label.to_owned()),
                    Some(false) => remove.push(label.to_owned()),
                    None => {}
                }
            }
        }
        Mutation::Mailboxes {
            add: added,
            remove: removed,
            ..
        } => {
            let settable = |list: &[MailboxRef]| -> Vec<String> {
                list.iter()
                    .map(|label| label.as_str().to_owned())
                    .filter(|label| !AUTOMATIC.contains(&label.as_str()))
                    .collect()
            };
            add = settable(added);
            remove = settable(removed);
        }
    }
    (add, remove)
}
