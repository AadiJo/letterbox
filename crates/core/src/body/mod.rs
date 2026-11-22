//! The body pipeline. Each body is processed once, after it arrives, and what it makes is
//! kept on its message (`Reading`), so every UI gets it and a restart does not redo it:
//!   - trackers come out of the HTML for good (trackers.rs),
//!   - every other remote image is blocked until the user shows it, in a second copy of the
//!     HTML where each is a placeholder (html.rs),
//!   - the quoted history at the end is found, as an offset a UI can fold at (quote.rs),
//!   - an unsubscribe link in the body is found, for when the headers name none (unsubscribe.rs).
//!
//! `flush` (subscriptions.rs) runs the pipeline on the stored bodies of the conversations
//! someone has open whose reading is missing or from an older VERSION, in one commit, before
//! it returns. So a body fetched in the background is processed in that background task, a
//! change to the rules reprocesses each body lazily when it is next opened, and a message
//! shows `loading` until then. Raising VERSION is how a rules change reaches stored bodies. A
//! message the user sends is processed as the outbox stores it (`processed_now`), so a reply
//! shows whole at once: it is the user's own draft, and small.
//!
//! A pass that reads color hints from the HTML, to restyle it for a dark reader, belongs in
//! html.rs beside `shown`, which already reads every element's inline style and every `<style>`
//! block. What it finds would be kept in `Processed` with the rest, under a new VERSION.
//!
//! HTML is hostile, so it is read with lol_html, Cloudflare's streaming rewriter (the engine
//! behind Workers' HTMLRewriter), and never with patterns. It tokenizes as the HTML standard
//! says, edits in place so the rest of the markup stays byte for byte, and builds no tree a
//! hostile body could inflate. It costs about ten crates and three linear passes per HTML
//! body. html5ever builds a full tree instead, but its mutable DOM (markup5ever_rcdom) is
//! marked unsupported, and reserializing a tree rewrites every body. The pipeline is not what
//! keeps a message safe: the renderer's sandbox and policy stay the last line.

mod html;
mod quote;
mod trackers;
mod unsubscribe;

use std::rc::Rc;

use letterbox_protocol::{
    Body, ChangeId, ChangeResult, CoreMessage, Images, MessageId, Quote, Refusal, ShowImages, Tracker, Unsubscribe,
    UnsubscribeSource,
};
use serde::{Deserialize, Serialize};

use crate::Inner;
use crate::adapter::{BodyResult, RemoteBody};
use crate::effect::Effect;
use crate::world::{
    AccountRecord, ChangeOutcome, ChangeRecord, MessageRecord, World, put_account, put_change, put_message, scoped,
};

/// The version of the rules. Raise it whenever a change to them would change a `Processed`.
const VERSION: u32 = 1;

/// The most characters a preview holds.
const PREVIEW: usize = 200;

/// What the pipeline made of a message's body, and the user's choice for its images.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Reading {
    /// None until the pipeline has run on the stored body.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    processed: Option<Processed>,
    /// True when the user showed this message's images (`ShowImages::Message`).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    show_images: bool,
}

impl Reading {
    /// True when there is nothing to keep, so the store leaves it out.
    pub fn is_unset(&self) -> bool {
        *self == Reading::default()
    }

    /// The pipeline's result, if it ran at this VERSION.
    fn current(&self) -> Option<&Processed> {
        self.processed.as_ref().filter(|processed| processed.version == VERSION)
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Processed {
    version: u32,
    /// The HTML with images shown. None for a plain text body, or one lol_html refused.
    html: Option<String>,
    /// The HTML with images blocked. None when it has no remote images: then it is `html`.
    blocked: Option<String>,
    remote: Vec<String>,
    trackers: Vec<(String, trackers::Reason)>,
    quote: Option<Folded>,
    /// The start of the new part (see `Body::Ready::preview`).
    preview: String,
    /// An unsubscribe link in the body.
    link: Option<String>,
}

/// Where a body's quote starts, in UTF-16 code units, and how many earlier messages it holds.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Folded {
    text: Option<u64>,
    html: Option<u64>,
    blocked: Option<u64>,
    earlier: u64,
}

/// Runs the pipeline on one body.
fn process(body: &RemoteBody) -> Processed {
    let units = |text: &str, at: usize| text[..at].encode_utf16().count() as u64;
    let text_quote = quote::text(&body.text);
    let new_text = &body.text[..text_quote.map_or(body.text.len(), |(at, _)| at)];
    let html = body.html.as_deref().and_then(html::process);
    let text_link = || unsubscribe::link_in_text(new_text);
    let text_at = text_quote.map(|(at, _)| units(&body.text, at));
    let text_earlier = text_quote.map_or(0, |(_, earlier)| earlier);
    let Some(html) = html else {
        return Processed {
            version: VERSION,
            html: None,
            blocked: None,
            remote: Vec::new(),
            trackers: Vec::new(),
            quote: text_at.map(|text| Folded {
                text: Some(text),
                html: None,
                blocked: None,
                earlier: text_earlier,
            }),
            preview: preview_of(new_text),
            link: text_link(),
        };
    };
    let (shown_at, blocked_at) = html.quote.unzip();
    let html_at = shown_at.map(|at| units(&html.shown, at));
    let blocked_at = blocked_at
        .flatten()
        .zip(html.blocked.as_deref())
        .map(|(at, blocked)| units(blocked, at));
    let quote = (text_at.is_some() || html_at.is_some()).then(|| Folded {
        text: text_at,
        html: html_at,
        blocked: blocked_at,
        earlier: text_earlier.max(html.earlier),
    });
    let preview = if new_text.trim().is_empty() {
        preview_of(&html.words)
    } else {
        preview_of(new_text)
    };
    Processed {
        version: VERSION,
        quote,
        preview,
        link: html.link.or_else(text_link),
        html: Some(html.shown),
        blocked: html.blocked,
        remote: html.remote,
        trackers: html.trackers,
    }
}

/// The first PREVIEW characters of `text`, each run of space made one.
fn preview_of(text: &str) -> String {
    let words: Vec<&str> = text.split_whitespace().collect();
    words.join(" ").chars().take(PREVIEW).collect()
}

/// True when a message holds a body the pipeline has not run on at this VERSION.
pub fn unprocessed(record: &MessageRecord) -> bool {
    matches!(record.body, Some(BodyResult::Body { .. })) && record.reading.current().is_none()
}

/// Whose choice shows a message's images: its sender's, when the account shows that address's, else its own.
pub fn shown(world: &World, record: &MessageRecord) -> ShowImages {
    let address = record.facts.from.address.to_lowercase();
    let account = world.accounts.get(&record.account_id);
    if account.is_some_and(|account| account.images_from.contains(&address)) {
        ShowImages::Sender
    } else if record.reading.show_images {
        ShowImages::Message
    } else {
        ShowImages::Blocked
    }
}

/// True when every message `record` replies to (its References) is in its conversation, and
/// there are at least `earlier` of them: then its quote only repeats what the conversation holds.
fn in_conversation(world: &World, record: &MessageRecord, earlier: u64) -> bool {
    let references = &record.facts.references;
    let held = |reference: &String| {
        let ids = world.messages_by_message_id.get(&scoped(&record.account_id, reference));
        let mut records = ids.into_iter().flatten().filter_map(|id| world.messages.get(id));
        records.any(|other| other.thread_id == record.thread_id)
    };
    references.len() as u64 >= earlier && !references.is_empty() && references.iter().all(held)
}

/// A message's stored body as a client sees it: loading until the pipeline has run on it.
pub fn ready(world: &World, record: &MessageRecord, body: &RemoteBody) -> Body {
    let Some(processed) = record.reading.current() else {
        return Body::Loading;
    };
    let shown = shown(world, record);
    let blocked = shown == ShowImages::Blocked && processed.blocked.is_some();
    let html = if blocked {
        processed.blocked.clone()
    } else {
        processed.html.clone()
    };
    Body::Ready {
        text: body.text.clone(),
        html,
        images: Images {
            shown,
            remote: processed.remote.clone(),
            trackers: processed
                .trackers
                .iter()
                .map(|(host, reason)| Tracker {
                    host: host.clone(),
                    reason: (*reason).into(),
                })
                .collect(),
        },
        quote: processed.quote.map(|folded| Quote {
            text: folded.text,
            html: if blocked { folded.blocked } else { folded.html },
            earlier: folded.earlier,
            in_conversation: in_conversation(world, record, folded.earlier),
        }),
        preview: processed.preview.clone(),
    }
}

/// How to unsubscribe from the list a message came from: its List-Unsubscribe header, else
/// the link the pipeline found in its body.
pub fn unsubscribe_of(record: &MessageRecord) -> Option<Unsubscribe> {
    unsubscribe::from_headers(&record.facts.headers).or_else(|| {
        let url = record.reading.current()?.link.clone()?;
        Some(Unsubscribe::Web {
            url,
            from: UnsubscribeSource::Body,
        })
    })
}

impl Inner {
    /// The reading of a body processed now. The outbox stores a sent message with it.
    pub(crate) fn processed_now(&self, body: &RemoteBody) -> Reading {
        self.meter.processed();
        Reading {
            processed: Some(process(body)),
            show_images: false,
        }
    }

    /// Runs the pipeline on these messages' bodies and keeps what it makes, in one commit.
    /// `flush` calls it with the unprocessed bodies of the open conversations.
    pub(crate) fn process_bodies(self: &Rc<Self>, ids: &[MessageId]) {
        let done: Vec<(MessageId, Processed)> = {
            let state = self.state.borrow();
            let records = ids.iter().filter_map(|id| state.world.messages.get(id));
            let bodies = records
                .filter(|record| unprocessed(record))
                .filter_map(|record| match &record.body {
                    Some(BodyResult::Body { body }) => Some((record.id.clone(), body)),
                    _ => None,
                });
            bodies
                .map(|(id, body)| {
                    self.meter.processed();
                    (id, process(body))
                })
                .collect()
        };
        if done.is_empty() {
            return;
        }
        self.commit(|world, tx, _| {
            for (id, processed) in done {
                let Some(record) = world.messages.get(&id).cloned() else {
                    continue;
                };
                let reading = Reading {
                    processed: Some(processed),
                    ..record.reading
                };
                put_message(world, tx, MessageRecord { reading, ..record });
            }
        });
    }

    /// Answers set-images: keeps the choice for the message and its sender, and settles at
    /// once, since it never leaves the device. See `Command::SetImages`.
    pub(crate) fn set_images(self: &Rc<Self>, change: ChangeId, message_id: &MessageId, show: ShowImages) {
        let found = {
            let world = &self.state.borrow().world;
            world.messages.get(message_id).cloned().and_then(|record| {
                let account = world.accounts.get(&record.account_id)?.clone();
                Some((record, account))
            })
        };
        let Some((record, account)) = found else {
            return self.reject(change, Refusal::UnknownTarget);
        };
        let address = record.facts.from.address.to_lowercase();
        let mut senders: Vec<String> = account
            .images_from
            .iter()
            .filter(|known| **known != address)
            .cloned()
            .collect();
        if show == ShowImages::Sender {
            senders.push(address);
        }
        let show_images = match show {
            ShowImages::Blocked => false,
            ShowImages::Message => true,
            ShowImages::Sender => record.reading.show_images,
        };
        let rev = self.commit_then(
            |world, tx, at| {
                if senders != account.images_from {
                    let account = AccountRecord {
                        images_from: senders,
                        ..account.clone()
                    };
                    put_account(world, tx, account);
                }
                if show_images != record.reading.show_images {
                    let reading = Reading {
                        show_images,
                        ..record.reading.clone()
                    };
                    put_message(
                        world,
                        tx,
                        MessageRecord {
                            reading,
                            ..record.clone()
                        },
                    );
                }
                let outcome = Some(ChangeOutcome {
                    rev: at,
                    result: ChangeResult::Done,
                });
                let effect = Effect::Images {
                    message_id: message_id.clone(),
                };
                let account_id = account.id.clone();
                put_change(
                    world,
                    tx,
                    ChangeRecord {
                        id: change.clone(),
                        account_id,
                        effect,
                        accepted_rev: at,
                        outcome,
                    },
                );
            },
            |rev| self.accepted(&change, rev),
        );
        self.send(CoreMessage::Settled {
            change,
            rev,
            result: ChangeResult::Done,
        });
    }
}
