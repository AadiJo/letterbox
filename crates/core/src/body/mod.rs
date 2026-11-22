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
//! shows `loading` until then. Raising VERSION is how a rules change reaches stored bodies.
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
};
use serde::{Deserialize, Serialize};

use crate::Inner;
use crate::adapter::{BodyResult, RemoteBody};
use crate::effect::Effect;
use crate::world::{
    AccountRecord, ChangeOutcome, ChangeRecord, MessageRecord, World, put_account, put_change, put_message,
};

/// The version of the rules. Raise it whenever a change to them would change a `Processed`.
const VERSION: u32 = 1;

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
    /// Where each quote starts, in UTF-16 code units: in the text, in `html` and in `blocked`.
    quote: (Option<u64>, Option<u64>, Option<u64>),
    /// An unsubscribe link in the body.
    link: Option<String>,
}

/// Runs the pipeline on one body.
fn process(body: &RemoteBody) -> Processed {
    let units = |text: &str, at: usize| text[..at].encode_utf16().count() as u64;
    let text_quote = quote::text(&body.text);
    let html = body.html.as_deref().and_then(html::process);
    let text_link = || unsubscribe::link_in_text(&body.text[..text_quote.unwrap_or(body.text.len())]);
    let Some(html) = html else {
        return Processed {
            version: VERSION,
            html: None,
            blocked: None,
            remote: Vec::new(),
            trackers: Vec::new(),
            quote: (text_quote.map(|at| units(&body.text, at)), None, None),
            link: text_link(),
        };
    };
    let (shown_at, blocked_at) = html.quote.unzip();
    let blocked_at = blocked_at.flatten();
    Processed {
        version: VERSION,
        quote: (
            text_quote.map(|at| units(&body.text, at)),
            shown_at.map(|at| units(&html.shown, at)),
            blocked_at
                .zip(html.blocked.as_deref())
                .map(|(at, blocked)| units(blocked, at)),
        ),
        link: html.link.or_else(text_link),
        html: Some(html.shown),
        blocked: html.blocked,
        remote: html.remote,
        trackers: html.trackers,
    }
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

/// A stored body as a client sees it: loading until the pipeline has run on it.
pub fn ready(body: &RemoteBody, reading: &Reading, shown: ShowImages) -> Body {
    let Some(processed) = reading.current() else {
        return Body::Loading;
    };
    let (text_at, shown_at, blocked_at) = processed.quote;
    let (html, html_at) = match (&processed.blocked, shown) {
        (Some(blocked), ShowImages::Blocked) => (Some(blocked.clone()), blocked_at),
        _ => (processed.html.clone(), shown_at),
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
        quote: Quote {
            text: text_at,
            html: html_at,
        },
    }
}

/// How to unsubscribe from the list a message came from: its List-Unsubscribe header, else
/// the link the pipeline found in its body.
pub fn unsubscribe_of(record: &MessageRecord) -> Option<Unsubscribe> {
    unsubscribe::from_headers(&record.facts.headers).or_else(|| {
        let link = record.reading.current()?.link.clone()?;
        Some(Unsubscribe::Link { url: link })
    })
}

impl Inner {
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
