//! The adapter for one signed-in Gmail account. Message ids are the message refs and
//! label ids are the mailbox refs: Gmail keeps both for the life of the message, so no
//! ref ever changes (rule 4) and `moved` is always empty.

use indexmap::IndexMap;
use letterbox_core::adapter::{
    Adapter, AdapterCapabilities, AdapterFailure, ApplyResult, BodyResult, ChangeSet, ChangesResult, Cursor,
    LocalFuture, MessageRef, Mutation, Outcome, PageToken, ProviderRefusal, RemoteMailbox, RemoteMessage, SnapshotPage,
};
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};

use crate::api::{Api, CallError};
use crate::labels;
use crate::message::{METADATA_HEADERS, remote_body, remote_message};
use crate::wire::{HistoryList, LabelList, Message, MessageList, Modify, Profile};

/// messages.list allows up to 500. 100 is its default.
const PAGE_SIZE: &str = "100";
/// "There is a limit of 1000 ids per request." (users.messages.batchModify)
const BATCH_LIMIT: usize = 1000;

/// What a cursor holds: the history id to resume from, and a digest of the mailbox list
/// the core has, since history.list does not report label changes.
#[derive(Serialize, Deserialize)]
struct Position {
    history: String,
    labels: String,
}

/// What a snapshot page token holds: the history id taken before the first page (rule 2),
/// and Gmail's own token for the next page of messages.list.
#[derive(Serialize, Deserialize)]
struct Page {
    history: String,
    page: String,
}

fn encode(value: &impl Serialize) -> String {
    serde_json::to_string(value).expect("cursors and page tokens are plain data")
}

/// What history said about one message.
#[derive(Default)]
struct Touched {
    added: bool,
    deleted: bool,
}

pub struct GmailAdapter {
    pub(crate) api: Api,
    /// False when the user granted read-only access.
    pub(crate) modify: bool,
}

impl GmailAdapter {
    /// The mailbox list now. Callers list it after the messages they report, so every label
    /// a reported message carries is in the list. The core drops labels it does not know.
    async fn mailboxes(&self) -> Result<Vec<RemoteMailbox>, CallError> {
        let list: LabelList = self.api.get("labels", &[]).await?;
        Ok(labels::mailboxes(&list.labels))
    }

    /// One message, by `format`. None if Gmail no longer has it.
    async fn message(&self, id: &str, query: &[(&str, &str)]) -> Result<Option<Message>, CallError> {
        match self.api.get(&format!("messages/{id}"), query).await {
            Ok(message) => Ok(Some(message)),
            Err(error) if error.is_not_found() => Ok(None),
            Err(error) => Err(error),
        }
    }

    /// One message's state and facts. None if Gmail no longer has it.
    async fn listed(&self, id: &str) -> Result<Option<RemoteMessage>, CallError> {
        let mut query = vec![("format", "metadata")];
        query.extend(METADATA_HEADERS.iter().map(|name| ("metadataHeaders", *name)));
        Ok(self.message(id, &query).await?.as_ref().map(remote_message))
    }

    async fn snapshot_page(&self, page: Option<PageToken>) -> Result<SnapshotPage, CallError> {
        let (history, page) = match page {
            None => {
                let profile: Profile = self.api.get("profile", &[]).await?;
                (profile.history_id, None)
            }
            Some(token) => {
                // A token this adapter cannot read gets the same answer as one Gmail refused: start over.
                let page: Page = serde_json::from_str(token.as_str())
                    .map_err(|_| CallError::Failure(AdapterFailure::PageExpired))?;
                (page.history, Some(page.page))
            }
        };
        // Trash and spam are mailboxes here, so list them too. messages.list leaves them out unless asked.
        let mut query = vec![("maxResults", PAGE_SIZE), ("includeSpamTrash", "true")];
        if let Some(page) = &page {
            query.push(("pageToken", page));
        }
        let list: MessageList = match self.api.get("messages", &query).await {
            Ok(list) => list,
            // Rule 8. Google documents no answer to an expired token. A live call with one it
            // never issued got 400 invalidArgument "Invalid pageToken", so a 400 to a call
            // that carried a token reads as one Gmail no longer accepts. The first page has
            // no token, so its 400 stays a provider error.
            Err(CallError::Status { status, .. }) if status == StatusCode::BAD_REQUEST && page.is_some() => {
                return Err(CallError::Failure(AdapterFailure::PageExpired));
            }
            Err(error) => return Err(error),
        };
        let mut messages = Vec::with_capacity(list.messages.len());
        for listed in &list.messages {
            // A message deleted since the list was made comes back from the next `changes`.
            if let Some(message) = self.listed(&listed.id).await? {
                messages.push(message);
            }
        }
        let mailboxes = self.mailboxes().await?;
        let (next, cursor) = match list.next_page_token {
            Some(page) => (Some(PageToken::new(encode(&Page { history, page }))), None),
            None => {
                let labels = labels::digest(&mailboxes);
                (None, Some(Cursor::new(encode(&Position { history, labels }))))
            }
        };
        Ok(SnapshotPage {
            mailboxes,
            messages,
            next,
            cursor,
        })
    }

    async fn changes_since(&self, cursor: Cursor) -> Result<ChangesResult, CallError> {
        // A cursor this adapter cannot read gets the same answer as one Gmail forgot: start over.
        let Ok(position) = serde_json::from_str::<Position>(cursor.as_str()) else {
            return Ok(ChangesResult::CursorExpired);
        };
        // Every message history names, in the order it first names them.
        let mut touched: IndexMap<String, Touched> = IndexMap::new();
        let mut newest = None;
        let mut page: Option<String> = None;
        loop {
            let mut query = vec![("startHistoryId", position.history.as_str())];
            if let Some(page) = &page {
                query.push(("pageToken", page));
            }
            let list: HistoryList = match self.api.get("history", &query).await {
                Ok(list) => list,
                // "If you receive an HTTP 404 error response, your application should perform a full sync."
                Err(error) if error.is_not_found() => return Ok(ChangesResult::CursorExpired),
                Err(error) => return Err(error),
            };
            // The first page's id. Records added while paging come after it, so the next call repeats them (rule 3).
            newest.get_or_insert(list.history_id);
            for record in &list.history {
                let named = record.messages.iter();
                let relabelled = record.labels_added.iter().chain(&record.labels_removed);
                for id in named.chain(relabelled.map(|changed| &changed.message)) {
                    touched.entry(id.id.clone()).or_default();
                }
                for changed in &record.messages_added {
                    touched.entry(changed.message.id.clone()).or_default().added = true;
                }
                for changed in &record.messages_deleted {
                    touched.entry(changed.message.id.clone()).or_default().deleted = true;
                }
            }
            match list.next_page_token {
                Some(next) => page = Some(next),
                None => break,
            }
        }

        // History names messages by id only, so each one's current state is fetched.
        let mut changes = ChangeSet {
            added: Vec::new(),
            updated: Vec::new(),
            removed: Vec::new(),
            mailboxes: None,
            cursor: cursor.clone(),
        };
        for (id, what) in touched {
            if what.deleted {
                changes.removed.push(MessageRef::new(id));
            } else if what.added {
                match self.listed(&id).await? {
                    Some(message) => changes.added.push(message),
                    None => changes.removed.push(MessageRef::new(id)),
                }
            } else {
                match self.message(&id, &[("format", "minimal")]).await? {
                    Some(message) => changes.updated.push(labels::state(&message.id, &message.label_ids)),
                    None => changes.removed.push(MessageRef::new(id)),
                }
            }
        }
        let mailboxes = self.mailboxes().await?;
        let labels = labels::digest(&mailboxes);
        if labels != position.labels {
            changes.mailboxes = Some(mailboxes);
        }
        let history = newest.unwrap_or(position.history);
        changes.cursor = Cursor::new(encode(&Position { history, labels }));
        Ok(ChangesResult::Changes(changes))
    }

    async fn body_of(&self, r#ref: MessageRef) -> Outcome<BodyResult> {
        match self.message(r#ref.as_str(), &[("format", "full")]).await {
            Ok(Some(message)) => Ok(BodyResult::Body {
                body: remote_body(&message),
            }),
            Ok(None) => Ok(BodyResult::Gone),
            Err(error) => Err(error.failure()),
        }
    }

    /// Changes one message's labels. Gmail answers 404 when it no longer has the message.
    async fn modify_one(&self, id: &str, add: &[String], remove: &[String]) -> Result<(), CallError> {
        let body = Modify {
            ids: None,
            add_label_ids: add,
            remove_label_ids: remove,
        };
        self.api.post(&format!("messages/{id}/modify"), &body).await
    }

    /// Changes many messages' labels. The reference does not say what batchModify does with
    /// an id Gmail no longer has, so on a 404 each message is modified alone (rule 5).
    /// Returns how many of `ids` still existed.
    async fn modify_many(&self, ids: &[String], add: &[String], remove: &[String]) -> Result<usize, CallError> {
        let mut found = 0;
        for chunk in ids.chunks(BATCH_LIMIT) {
            let body = Modify {
                ids: Some(chunk),
                add_label_ids: add,
                remove_label_ids: remove,
            };
            match self.api.post("messages/batchModify", &body).await {
                Ok(()) => found += chunk.len(),
                Err(error) if error.is_not_found() => {
                    for id in chunk {
                        match self.modify_one(id, add, remove).await {
                            Ok(()) => found += 1,
                            Err(error) if error.is_not_found() => {}
                            Err(error) => return Err(error),
                        }
                    }
                }
                Err(error) => return Err(error),
            }
        }
        Ok(found)
    }

    async fn apply_mutation(&self, mutation: Mutation) -> Outcome<ApplyResult> {
        let refused = |reason| Ok(ApplyResult::Refused { reason });
        if !self.modify {
            return refused(ProviderRefusal::NotPermitted);
        }
        let refs = match &mutation {
            Mutation::Flags { refs, .. } | Mutation::Mailboxes { refs, .. } => refs,
        };
        let ids: Vec<String> = refs.iter().map(|r#ref| r#ref.as_str().to_owned()).collect();
        let (add, remove) = labels::edits(&mutation);
        if add.is_empty() && remove.is_empty() {
            // Only SENT or DRAFT were named. Gmail sets those itself, and no change reports them back.
            return refused(ProviderRefusal::NotSupported);
        }
        // Each step stays within the 100-label limit. A step that finds no message, or fails, ends it.
        let mut found = Ok(0);
        for (add, remove) in labels::in_steps(&add, &remove) {
            found = match ids.as_slice() {
                [id] => self.modify_one(id, add, remove).await.map(|()| 1),
                _ => self.modify_many(&ids, add, remove).await,
            };
            if !matches!(found, Ok(count) if count > 0) {
                break;
            }
        }
        match found {
            Ok(0) => refused(ProviderRefusal::UnknownTarget),
            Ok(_) => Ok(ApplyResult::Applied { moved: Vec::new() }),
            Err(CallError::Failure(failure)) => Err(failure),
            // Over a usage limit, not refused: the core keeps the change and tries it again later.
            Err(error) if error.is_usage_limit() => Err(AdapterFailure::ProviderError),
            Err(CallError::Status { status, .. }) => match status {
                StatusCode::NOT_FOUND => refused(ProviderRefusal::UnknownTarget),
                StatusCode::BAD_REQUEST => refused(ProviderRefusal::RefusedByProvider),
                StatusCode::CONFLICT => refused(ProviderRefusal::Conflict),
                StatusCode::FORBIDDEN => refused(ProviderRefusal::NotPermitted),
                _ => Err(AdapterFailure::ProviderError),
            },
        }
    }
}

impl Adapter for GmailAdapter {
    fn capabilities(&self) -> AdapterCapabilities {
        AdapterCapabilities {
            modify: self.modify,
            send: false,
            multiple_mailboxes: true,
        }
    }

    fn snapshot(&self, page: Option<PageToken>) -> LocalFuture<'_, Outcome<SnapshotPage>> {
        Box::pin(async move { self.snapshot_page(page).await.map_err(|error| error.failure()) })
    }

    fn changes(&self, cursor: Cursor) -> LocalFuture<'_, Outcome<ChangesResult>> {
        Box::pin(async move { self.changes_since(cursor).await.map_err(|error| error.failure()) })
    }

    fn body(&self, r#ref: MessageRef) -> LocalFuture<'_, Outcome<BodyResult>> {
        Box::pin(self.body_of(r#ref))
    }

    fn apply(&self, mutation: Mutation) -> LocalFuture<'_, Outcome<ApplyResult>> {
        Box::pin(self.apply_mutation(mutation))
    }

    fn stop_waiting(&self) {
        self.api.close();
    }

    fn close(&self) -> LocalFuture<'_, ()> {
        // Requests in flight finish on their own. The client's connections close when it drops.
        self.stop_waiting();
        Box::pin(async {})
    }
}
