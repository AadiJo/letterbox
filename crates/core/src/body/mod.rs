//! The body pipeline. Each body is processed once, after it arrives, and what it makes is
//! kept on its message (`Reading`), so every UI gets it and a restart does not redo it:
//!   - trackers come out of the HTML for good (trackers.rs),
//!   - every other remote image becomes a placeholder, and the core fetches it only once the
//!     user shows the message's images (html.rs, fetch.rs),
//!   - the quoted history at the end is found, as an offset a UI can fold at (quote.rs),
//!   - an unsubscribe link in the body is found, for when the headers name none (unsubscribe.rs).
//!
//! When it runs:
//!   - A body fetched from the provider is processed in its fetch, in the account's queue,
//!     before it is stored (`processed_now`, sync.rs).
//!   - A message the user sends is processed as the outbox stores it, so a reply shows whole at
//!     once, unless its body is over SEND_LIMIT: then it waits for the next point.
//!   - A stored body with no reading at this VERSION, after a rules change or a big send, is
//!     processed by a job in its account's queue once someone opens its conversation
//!     (`reprocess`, from `flush`), never in `flush` itself. It shows `loading` until then.
//!     Raising VERSION is how a rules change reaches stored bodies, lazily.
//!
//! A pass that reads color hints from the HTML, to restyle it for a dark reader, belongs in
//! html.rs beside `rewrite`, which already reads every element's inline style and every
//! `<style>` block. What it finds would be kept in `Processed` with the rest, under a new VERSION.
//!
//! HTML is hostile, so it is read with lol_html, Cloudflare's streaming rewriter (the engine
//! behind Workers' HTMLRewriter), and never with patterns. It tokenizes as the HTML standard
//! says, edits in place so the rest of the markup stays byte for byte, and builds no tree a
//! hostile body could inflate. It costs about ten crates and three linear passes per HTML
//! body. html5ever builds a full tree instead, but its mutable DOM (markup5ever_rcdom) is
//! marked unsupported, and reserializing a tree rewrites every body. The pipeline is not what
//! keeps a message safe: the renderer's sandbox and policy, which never reach the network,
//! stay the last line.

mod fetch;
mod html;
mod quote;
mod rewrite;
mod trackers;
mod unsubscribe;

use std::rc::Rc;

use letterbox_protocol::{
    AccountId, Body, ChangeId, ChangeResult, CoreMessage, Images, MessageId, Quote, Refusal, ShowImages, Tracker,
    Unsubscribe, UnsubscribeSource,
};
use serde::{Deserialize, Serialize};

use crate::Inner;
use crate::adapter::{BodyResult, RemoteBody};
use crate::effect::Effect;
use crate::world::{ChangeOutcome, ChangeRecord, MessageRecord, World, put_change, put_message, scoped};

/// The version of the rules. Raise it whenever a change to them would change a `Processed`.
const VERSION: u32 = 5;

/// The most characters a preview holds.
const PREVIEW: usize = 200;

/// The largest sent body, text and HTML together, processed as the outbox stores it. A
/// forward carries the received HTML, which can be large, and the send's command waits for it.
const SEND_LIMIT: usize = 64 * 1024;

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

    /// This reading with `processed` in place of what it had.
    fn with(self, processed: Processed) -> Reading {
        Reading {
            processed: Some(processed),
            ..self
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Processed {
    version: u32,
    /// The HTML a UI shows (html.rs). None for a plain text body, or one lol_html refused.
    html: Option<String>,
    remote: Vec<String>,
    trackers: Vec<(String, trackers::Reason)>,
    quote: Option<Folded>,
    /// The start of the new part (see `Body::Ready::preview`).
    preview: String,
    /// True when the message has HTML that `html::process` would not pass on (see `Body::Ready::html_withheld`).
    #[serde(default)]
    withheld: bool,
    /// An unsubscribe link in the body.
    link: Option<String>,
    /// The start of the CSS custom property names in `html` (see `Body::Ready::css_prefix`).
    #[serde(default)]
    css_prefix: String,
}

/// Where a body's quote starts, in UTF-16 code units, in the text and in the HTML.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Folded {
    text: Option<u64>,
    html: Option<u64>,
}

/// Runs the pipeline on one body, naming its CSS custom properties with `prefix`. Without a
/// prefix, its HTML is withheld.
fn process(body: &RemoteBody, prefix: Option<String>) -> Processed {
    let units = |text: &str, at: usize| text[..at].encode_utf16().count() as u64;
    let text_quote = quote::text(&body.text);
    let new_text = &body.text[..text_quote.unwrap_or(body.text.len())];
    let html = body
        .html
        .as_deref()
        .zip(prefix.as_deref())
        .and_then(|(html, prefix)| html::process(html, prefix));
    let prefix = prefix.unwrap_or_default();
    let text_link = || unsubscribe::link_in_text(new_text);
    let text_at = text_quote.map(|at| units(&body.text, at));
    let Some(html) = html else {
        return Processed {
            version: VERSION,
            html: None,
            remote: Vec::new(),
            trackers: Vec::new(),
            quote: text_at.map(|text| Folded {
                text: Some(text),
                html: None,
            }),
            preview: preview_of(new_text),
            link: text_link(),
            withheld: body.html.is_some(),
            css_prefix: prefix,
        };
    };
    let html_at = html.quote.map(|at| units(&html.html, at));
    let quote = (text_at.is_some() || html_at.is_some()).then_some(Folded {
        text: text_at,
        html: html_at,
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
        html: Some(html.html),
        remote: html.remote,
        trackers: html.trackers,
        withheld: false,
        css_prefix: prefix,
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

/// Whether a message's images are shown: by the user's choice for that message alone.
///
/// There is no choice for a sender. Showing images tells the server the mail was opened, so a
/// choice that carried over to other mail from an address would let anyone who writes that
/// address in a From learn when mail is read. No provider gives a sure sign of who sent a
/// message: Gmail documents nothing that tells mail its inbound check passed from mail that
/// skipped it (an API insert, IMAP APPEND, POP or Gmailify fetches, a migration), and IMAP
/// folders carry no verdict at all. A choice per sender waits for a sign that can be trusted,
/// such as a validated ARC verdict from Google.
pub fn shown(record: &MessageRecord) -> ShowImages {
    if record.reading.show_images {
        ShowImages::Message
    } else {
        ShowImages::Blocked
    }
}

/// True when `record` replies to messages (its References) and every one is in its
/// conversation: then its quote only repeats what the conversation holds.
fn in_conversation(world: &World, record: &MessageRecord) -> bool {
    let references = &record.facts.references;
    let held = |reference: &String| {
        let ids = world.messages_by_message_id.get(&scoped(&record.account_id, reference));
        let mut records = ids.into_iter().flatten().filter_map(|id| world.messages.get(id));
        records.any(|other| other.thread_id == record.thread_id)
    };
    !references.is_empty() && references.iter().all(held)
}

/// A message's stored body as a client sees it: loading until the pipeline has run on it.
pub fn ready(world: &World, record: &MessageRecord, body: &RemoteBody) -> Body {
    let Some(processed) = record.reading.current() else {
        return Body::Loading;
    };
    Body::Ready {
        text: body.text.clone(),
        html: processed.html.clone(),
        images: Images {
            shown: shown(record),
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
            html: folded.html,
            in_conversation: in_conversation(world, record),
        }),
        preview: processed.preview.clone(),
        html_withheld: processed.withheld,
        css_prefix: processed.css_prefix.clone(),
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
    /// `reading` with `body` processed now. A gone body leaves it as it is. Each processing
    /// draws a new CSS prefix of 128 bits from `Environment::secret`: the operating system's
    /// cryptographic source in the app, a counter on the test clock, so a scenario's runs stay
    /// the same. Should the source fail, the HTML is withheld, as for HTML the core cannot make safe.
    pub(crate) fn processed_now(&self, body: &BodyResult, reading: Reading) -> Reading {
        let BodyResult::Body { body } = body else {
            return reading;
        };
        self.meter.processed();
        let prefix = self.env.secret().map(|bytes| {
            let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
            format!("--letterbox-{hex}-")
        });
        reading.with(process(body, prefix))
    }

    /// A sent body's reading: processed now when it is at most SEND_LIMIT, else left for
    /// `reprocess`, so a large forward does not hold up its send's command.
    pub(crate) fn processed_for_send(&self, body: &BodyResult) -> Reading {
        let size = match body {
            BodyResult::Body { body } => body.text.len() + body.html.as_ref().map_or(0, String::len),
            BodyResult::Gone => 0,
        };
        if size > SEND_LIMIT {
            Reading::default()
        } else {
            self.processed_now(body, Reading::default())
        }
    }

    /// Queues a job in each message's account queue that processes its stored body, once per
    /// message: one already queued is not queued again. `flush` calls it with the unprocessed
    /// bodies of the open conversations.
    pub(crate) fn reprocess(self: &Rc<Self>, wanted: Vec<(AccountId, MessageId)>) {
        let fresh: Vec<(AccountId, MessageId)> = {
            let mut state = self.state.borrow_mut();
            wanted
                .into_iter()
                .filter(|(_, id)| state.processing.insert(id.clone()))
                .collect()
        };
        for (account_id, id) in fresh {
            let core = Rc::clone(self);
            self.background(&account_id, async move { core.process_stored(id) });
        }
    }

    /// The job `reprocess` queues: processes one stored body and keeps the result.
    fn process_stored(self: &Rc<Self>, id: MessageId) {
        let done = {
            let mut state = self.state.borrow_mut();
            state.processing.remove(&id);
            let record = state.world.messages.get(&id).filter(|record| unprocessed(record));
            record.and_then(|record| match &record.body {
                Some(body @ BodyResult::Body { .. }) => Some(self.processed_now(body, Reading::default())),
                _ => None,
            })
        };
        let Some(Reading {
            processed: Some(processed),
            ..
        }) = done
        else {
            return;
        };
        self.commit(|world, tx, _| {
            if let Some(record) = world.messages.get(&id).cloned() {
                let reading = record.reading.clone().with(processed);
                put_message(world, tx, MessageRecord { reading, ..record });
            }
        });
    }

    /// Answers set-images: keeps the choice for the message, and settles at once, since it
    /// never leaves the device. See `Command::SetImages`.
    pub(crate) fn set_images(self: &Rc<Self>, change: ChangeId, message_id: &MessageId, show: ShowImages) {
        let record = self.state.borrow().world.messages.get(message_id).cloned();
        let Some(record) = record else {
            return self.reject(change, Refusal::UnknownTarget);
        };
        let show_images = show == ShowImages::Message;
        let rev = self.commit_then(
            |world, tx, at| {
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
                put_change(
                    world,
                    tx,
                    ChangeRecord {
                        id: change.clone(),
                        account_id: record.account_id.clone(),
                        effect: Effect::Images {
                            message_id: message_id.clone(),
                        },
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
