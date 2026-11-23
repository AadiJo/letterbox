//! Commands: the user intents a UI sends, each answered `accepted` or `rejected`, then `settled`.

use serde::Deserialize;
use ts_rs::TS;

use crate::{ChangeId, Draft, MailboxId, MessageId, ShowImages, ThreadId, Turn, present};

/// A user intent. Every command but set-images and unsubscribe acts on whole threads.
/// Only set-turn and set-images work with read-only access, because they never leave the device.
#[derive(Clone, Debug, PartialEq, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum Command {
    /// Correct the rule, or hand the thread back to it with `auto`. A turn set holds until the
    /// conversation gets a message sent after its newest one then, from anyone, once the provider
    /// holds it. Then the rule decides again: their reply to a conversation marked done is my turn.
    /// `none` is Done, and is how a turn in Let go? is let go: it leaves Your turn and Let go? both.
    SetTurn {
        thread_ids: Vec<ThreadId>,
        turn: TurnChoice,
    },
    SetFlags {
        thread_ids: Vec<ThreadId>,
        #[serde(default, deserialize_with = "present")]
        #[ts(optional)]
        unread: Option<bool>,
        #[serde(default, deserialize_with = "present")]
        #[ts(optional)]
        flagged: Option<bool>,
    },
    /// Archive is `remove: [inbox]`. A move is one add and one remove.
    SetMailboxes {
        thread_ids: Vec<ThreadId>,
        add: Vec<MailboxId>,
        remove: Vec<MailboxId>,
    },
    Trash {
        thread_ids: Vec<ThreadId>,
    },
    Send {
        draft: Draft,
    },
    /// Shows or blocks one message's remote images, and settles at once: it never leaves the
    /// device. The message then reports `show` in `body.images.shown`, and no other message
    /// changes. Refused `not-supported` for an undo.
    SetImages {
        message_id: MessageId,
        show: ShowImages,
    },
    /// Unsubscribes from the sender of `message_id`, by the way the message's `unsubscribe`
    /// names, once the user has confirmed: doing it tells the sender the address is read. The
    /// sender's row in Updates shows it from the accept on (`SenderSummary::unsubscribed`).
    ///
    /// It is held for the same undo window as a send, and an `undo` naming the change cancels
    /// it until then: nothing leaves the device, not even a DNS lookup. A restart inside the
    /// window keeps it held until the saved deadline. Then the core carries it out:
    ///   - one-click: it fetches the message's raw source, once, and checks for a DKIM
    ///     signature that verifies and covers List-Unsubscribe and List-Unsubscribe-Post, as
    ///     RFC 8058 asks. If one does, it POSTs `List-Unsubscribe=One-Click` to the URL those
    ///     signed headers name, once, with no cookies or credentials, and follows no redirect.
    ///     If none does, or the source cannot be fetched, or the URL carries a user name or
    ///     password, it goes out as the header's mailto, else it leaves the page.
    ///   - mailto: it sends the email the URI describes from the account, through the outbox,
    ///     once. It shows in Sent like any send.
    ///   - web: the core opens nothing. The page is kept on the sender's row in Updates
    ///     (`Unsubscribed::Page`), for the user to open.
    ///
    /// It settles `done` once carried out, or once its page is kept. It fails `not-public` when the one-click URL's host
    /// is not on the public internet, so nothing was sent, `refused-by-provider` when the
    /// sender's server answered with an error or a redirect, `unconfirmed` when the POST went
    /// out and no answer came (it is not sent again), and as its email's send fails for mailto.
    /// Rejected `unknown-target` for a message the core does not have, `not-supported` for one
    /// that names no way to unsubscribe, `not-permitted` for a mailto from an account that
    /// cannot send, and `conflict` while an unsubscribe from the same sender is held or sending.
    Unsubscribe {
        message_id: MessageId,
    },
    /// Takes back one change, exactly. A change the provider has none of is cancelled: it
    /// never goes out, it settles `undone`, and the undo settles `done`. A change the provider
    /// may hold is reversed by the undo itself, a change of its own that settles like any other:
    /// each message the change altered gets back the mailboxes, read and flag state it changed,
    /// and nothing else. A turn correction is reversed at once, unless the conversation got a
    /// newer message since: then it is refused `conflict`, `changed`.
    ///
    /// An undo trusts only what the provider confirmed. A send or an unsubscribe is cancelled
    /// only inside its undo window, and refused `conflict` after it. Otherwise it is refused `conflict`, with
    /// the reason in `conflict`:
    ///   - `outcome-unknown` while the provider has not confirmed what the change did: a call
    ///     for it reached the provider and it has not settled, or it failed after part of it
    ///     went through and no sync has run since, or another such change touches its messages.
    ///   - `changed` when a field the change set no longer holds what it set: changed since,
    ///     here or at the provider, or its message or conversation is gone.
    ///   - `partly-applied` when it failed, and a sync since shows a field it set never took it.
    ///   - `mailbox-gone` when the undo would put a message back in a mailbox that is gone.
    ///
    /// Refused `conflict` with no reason when it failed before any of it went through (it is
    /// rolled back already), or an undo of it is pending or done. Refused `not-supported` for
    /// an undo, which cannot itself be undone. Sending the same undo twice has one effect
    /// (guarantee 4).
    Undo {
        change: ChangeId,
    },
}

/// The turn a set-turn command asks for: a fixed holder, or `auto` to hand it back to the rule.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum TurnChoice {
    Mine,
    Theirs,
    #[serde(rename = "none")]
    Nobody,
    Auto,
}

impl TurnChoice {
    /// The turn the user fixed, or None when the rule decides.
    pub fn fixed(self) -> Option<Turn> {
        match self {
            TurnChoice::Mine => Some(Turn::Mine),
            TurnChoice::Theirs => Some(Turn::Theirs),
            TurnChoice::Nobody => Some(Turn::Nobody),
            TurnChoice::Auto => None,
        }
    }
}
