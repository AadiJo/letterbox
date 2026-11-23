//! The Gmail REST API's JSON, as far as the adapter reads it. Fields the adapter does
//! not use are left out, and serde skips them. Shapes follow the reference at
//! https://developers.google.com/gmail/api/reference/rest/v1/users.messages and its siblings.

use serde::{Deserialize, Serialize};

/// users.getProfile.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub email_address: String,
    pub history_id: String,
}

/// users.labels.list.
#[derive(Debug, Default, Deserialize)]
pub struct LabelList {
    #[serde(default)]
    pub labels: Vec<Label>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Label {
    pub id: String,
    pub name: String,
    #[serde(rename = "type", default)]
    pub kind: Option<String>,
}

/// users.messages.list: ids only. "each message resource contains only an id and a threadId".
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageList {
    #[serde(default)]
    pub messages: Vec<MessageId>,
    pub next_page_token: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct MessageId {
    pub id: String,
}

/// users.messages.get in any format. Fields the format leaves out stay at their default.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub id: String,
    pub thread_id: Option<String>,
    #[serde(default)]
    pub label_ids: Vec<String>,
    #[serde(default)]
    pub snippet: String,
    /// Epoch milliseconds, as a string.
    pub internal_date: Option<String>,
    #[serde(default)]
    pub size_estimate: u64,
    pub payload: Option<Part>,
}

/// users.messages.get with format=raw: the whole message, base64url. "Returns the full email
/// message data with body content in the raw field as a base64url encoded string."
#[derive(Debug, Deserialize)]
pub struct RawMessage {
    #[serde(default)]
    pub raw: String,
}

/// One MIME part. The top-level part carries the message headers.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Part {
    #[serde(default)]
    pub mime_type: String,
    #[serde(default)]
    pub filename: String,
    #[serde(default)]
    pub headers: Vec<Header>,
    #[serde(default)]
    pub body: PartBody,
    #[serde(default)]
    pub parts: Vec<Part>,
}

#[derive(Debug, Deserialize)]
pub struct Header {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PartBody {
    #[serde(default)]
    pub size: u64,
    /// The content as base64url, when it is inline in the response.
    pub data: Option<String>,
    /// Names an attachment whose content is not inline, for users.messages.attachments.get.
    /// It can differ from one messages.get to the next, so it is used only fresh.
    #[serde(default)]
    pub attachment_id: Option<String>,
}

/// users.history.list.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryList {
    #[serde(default)]
    pub history: Vec<History>,
    pub next_page_token: Option<String>,
    pub history_id: String,
}

/// One history record. Each list names messages that changed, typically by id only.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct History {
    #[serde(default)]
    pub messages: Vec<MessageId>,
    #[serde(default)]
    pub messages_added: Vec<Changed>,
    #[serde(default)]
    pub messages_deleted: Vec<Changed>,
    #[serde(default)]
    pub labels_added: Vec<Changed>,
    #[serde(default)]
    pub labels_removed: Vec<Changed>,
}

#[derive(Debug, Deserialize)]
pub struct Changed {
    pub message: MessageId,
}

/// The body of users.messages.modify and, with `ids`, users.messages.batchModify.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Modify<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ids: Option<&'a [String]>,
    pub add_label_ids: &'a [String],
    pub remove_label_ids: &'a [String],
}

/// The body of users.messages.send: the whole message as base64url, and the thread it joins.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Send<'a> {
    pub raw: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<&'a str>,
}

/// The error body every Gmail endpoint returns. Only `reason` tells a rate limit apart
/// from a missing permission on a 403.
/// https://developers.google.com/gmail/api/guides/handle-errors
#[derive(Debug, Default, Deserialize)]
pub struct ApiError {
    #[serde(default)]
    pub error: ApiErrorBody,
}

#[derive(Debug, Default, Deserialize)]
pub struct ApiErrorBody {
    #[serde(default)]
    pub errors: Vec<ApiErrorItem>,
}

#[derive(Debug, Default, Deserialize)]
pub struct ApiErrorItem {
    #[serde(default)]
    pub reason: String,
}

/// The token endpoint's answer to a code exchange or a refresh.
#[derive(Debug, Deserialize)]
pub struct Tokens {
    pub access_token: String,
    /// Returned on a code exchange. "refresh tokens are always returned for installed applications."
    pub refresh_token: Option<String>,
    /// Space-separated scopes the user granted.
    #[serde(default)]
    pub scope: String,
}

/// The token endpoint's error body: `{"error": "invalid_grant", ...}`.
#[derive(Debug, Default, Deserialize)]
pub struct TokenError {
    #[serde(default)]
    pub error: String,
}
