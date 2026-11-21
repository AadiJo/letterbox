//! Recipient suggestions: what the `recipients` live view answers.

use serde::Serialize;
use ts_rs::TS;

/// Someone a `recipients` view suggests for a recipient field on `account_id`: a person the
/// user wrote to, or who wrote to the user, in the mail the core holds. Mail from machines
/// (list or bulk headers, or the provider's bulk verdict) and mail in spam count for nothing.
/// No-reply addresses and the account's own are never suggested. `prefix` matches, without
/// case, the start of the address, of any word of a name, or of a whole name. An empty prefix
/// suggests nobody.
///
/// People the user wrote to come first, then people who only wrote to the user. Within each
/// group, people with more and newer mail come first: each message with them counts twice as
/// much as one from 30 days before it. Then the one with the newest mail, then by address.
///
/// `address` is as their newest mail wrote it, and `name` is the newest display name their
/// mail gave, if any.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
pub struct Recipient {
    pub name: Option<String>,
    pub address: String,
}
