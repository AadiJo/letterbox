//! What a subscription asks for and what it is sent: every live view, and its answer.

use std::num::NonZeroU64;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::{
    Account, AccountId, Mailbox, MailboxId, Recipient, SenderPage, SignInOption, ThreadDetail, ThreadFilter, ThreadId,
    ThreadSummary, present,
};

/// Every live view. Add a variant here and a matching one to `Update`.
#[derive(Clone, Debug, PartialEq, Deserialize, TS)]
#[serde(tag = "view", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum Query {
    Accounts,
    SignInOptions,
    Mailboxes {
        #[serde(default, deserialize_with = "present")]
        #[ts(optional)]
        account_id: Option<AccountId>,
    },
    Threads {
        filter: ThreadFilter,
        offset: u64,
        limit: NonZeroU64,
    },
    /// `null` once the thread no longer exists.
    Thread {
        thread_id: ThreadId,
    },
    /// Updates: the automated conversations in the account and mailbox given, grouped by sender.
    Senders {
        #[serde(default, deserialize_with = "present")]
        #[ts(optional)]
        account_id: Option<AccountId>,
        #[serde(default, deserialize_with = "present")]
        #[ts(optional)]
        mailbox_id: Option<MailboxId>,
        /// The user's IANA time zone, such as "America/Chicago": `days` are their days in it,
        /// and move on at its midnight. Leave out, or name a zone the core does not know, for UTC.
        #[serde(default, deserialize_with = "present")]
        #[ts(optional)]
        zone: Option<String>,
        offset: u64,
        limit: NonZeroU64,
    },
    /// People to suggest in a recipient field, best first (see `Recipient`).
    Recipients {
        account_id: AccountId,
        prefix: String,
        limit: NonZeroU64,
    },
}

/// The answer to a query. A threads update replaces the whole window.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(tag = "view", rename_all = "kebab-case")]
pub enum Update {
    Accounts { data: Vec<Account> },
    SignInOptions { data: Vec<SignInOption> },
    Mailboxes { data: Vec<Mailbox> },
    Threads { data: ThreadPage },
    Thread { data: Option<ThreadDetail> },
    Senders { data: SenderPage },
    Recipients { data: Vec<Recipient> },
}

#[derive(Clone, Debug, PartialEq, Serialize, TS)]
pub struct ThreadPage {
    pub total: u64,
    pub threads: Vec<ThreadSummary>,
}
