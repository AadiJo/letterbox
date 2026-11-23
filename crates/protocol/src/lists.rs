//! What the lists of conversations take and show: the filter a threads view takes, and
//! Updates, where automated mail is grouped by sender.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::{AccountId, MailboxId, SenderId, Time, Turn, Unsubscribe, Unsubscribed, present};

#[derive(Clone, Debug, Default, PartialEq, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ThreadFilter {
    /// Leave out to list every account together.
    #[serde(default, deserialize_with = "present")]
    #[ts(optional)]
    pub account_id: Option<AccountId>,
    #[serde(default, deserialize_with = "present")]
    #[ts(optional)]
    pub mailbox_id: Option<MailboxId>,
    #[serde(default, deserialize_with = "present")]
    #[ts(optional)]
    pub turn: Option<Turn>,
    #[serde(default, deserialize_with = "present")]
    #[ts(optional)]
    pub unread: Option<bool>,
    /// Full-text search over the local index.
    #[serde(default, deserialize_with = "present")]
    #[ts(optional)]
    pub text: Option<String>,
    /// True lists only conversations whose last message is 30 days old or more, false only the
    /// newer ones. With `turn: mine` these are Let go? and Your turn. The core's clock decides,
    /// so a conversation moves from one list to the other while the app runs. Leave out for both.
    #[serde(default, deserialize_with = "present")]
    #[ts(optional)]
    pub retired: Option<bool>,
    /// Only the conversations Updates groups under this sender (see `SenderSummary`).
    #[serde(default, deserialize_with = "present")]
    #[ts(optional)]
    pub sender: Option<SenderId>,
}

/// One row of Updates: every automated conversation from one sender, in one account. A
/// conversation is automated when its newest message from someone else is (see turns.rs in
/// the core). Its sender is that message's address, compared without case, so news@ and
/// no-reply@ of one company are two senders. To act on all of a sender's conversations, list
/// them with `sender` in a threads filter and send one command naming their ids: an Archive all
/// after an unsubscribe archives `threads` conversations holding `messages` messages.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SenderSummary {
    pub id: SenderId,
    pub account_id: AccountId,
    /// The name and address the newest conversation's message came from.
    pub name: Option<String>,
    pub address: String,
    /// How many conversations, how many messages are in them, and how many of those are unread.
    pub threads: u64,
    pub messages: u64,
    pub unread: u64,
    /// The newest conversation's subject, and when its last message came.
    pub subject: String,
    pub last_message_at: Time,
    /// The messages in its conversations sent on each of the last 14 days, oldest first, the
    /// last entry today. Days are the user's, in the query's `zone`, on the core's clock, which
    /// moves them on at the zone's midnight.
    pub days: Vec<SenderDay>,
    /// How to unsubscribe, from the message the row's name and address come from: its
    /// List-Unsubscribe header, or else a link in its body if that has loaded.
    pub unsubscribe: Option<Unsubscribe>,
    /// The user's unsubscribe from this address, while it is held, on its way or done. None
    /// when there is none, or the last one was undone or failed.
    pub unsubscribed: Option<Unsubscribed>,
}

/// One day of a sender's mail in Updates: how many messages were sent that day, and how many
/// of them are unread.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, TS)]
pub struct SenderDay {
    pub messages: u64,
    pub unread: u64,
}

/// One window of Updates, newest sender first. `total` counts every sender in it,
/// `unread_senders` those with unread mail, and `unread` their unread messages.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SenderPage {
    pub total: u64,
    pub unread_senders: u64,
    pub unread: u64,
    pub senders: Vec<SenderSummary>,
}
