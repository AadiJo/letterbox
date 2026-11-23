//! Unsubscribing from a sender, once the user confirms (`Command::Unsubscribe`). This module
//! owns each step, so its rules hold in one place:
//!
//!   - Accepting picks the way from the message (`unsubscribe_of` in body/mod.rs) and stores
//!     the change `Held` for the same undo window as a send (`window_end` in outbox.rs).
//!     The sender's row in Updates shows it from that commit on (`state`).
//!   - `undo` cancels it while the clock reads before the saved deadline (undo.rs passes every
//!     undo of one here). Nothing has left the device then: the core fetches, looks up and
//!     sends nothing for it before the window ends.
//!   - A restart inside the window holds it again until the same deadline, so the user can
//!     still undo it, and one whose window ended while the core was stopped goes on at once.
//!     The window is the promise that nothing goes out before it ends, and a restart is not
//!     the user's doing, so it neither cuts the window short nor drops the unsubscribe.
//!   - Then it is `Due`, and a job in its account's queue carries it out by its way:
//!     - web: one commit keeps the page, `Page`, and settles it done. The core opens nothing:
//!       Updates offers the page, and opening it is the user's own action in the shell. A page
//!       the core opened by itself, after a restart say, would visit an unverified URL unasked.
//!     - mailto: the change becomes a send of the email the URI describes, due at once
//!       (`store_send` in outbox.rs). The outbox delivers it once (adapter rule 10), and it
//!       settles as that send does.
//!     - one-click: the core fetches the raw message, once, and checks its DKIM signature
//!       (dkim.rs). If the check holds, it saves `Posting`, then POSTs once. If it does not,
//!       or the source cannot be had, it goes out as the header's mailto when the account can
//!       send (`without_one_click` in body/unsubscribe.rs), else it keeps the page: the
//!       one-click URL is an https URI of the header, so a page always remains.
//!   - A POST that may have reached the server is never sent again: a restart that finds one
//!     `Posting` fails it `unconfirmed`. One that surely did not go, as when no connection
//!     could be made, goes out as mailto or web instead.
//!
//! Updates shows where the newest unsubscribe from each address has got (`state`), keyed by
//! account and From address, compared without case. Anyone can write any address in a From,
//! so the key decides nothing but what a row shows.

mod dkim;
mod mailto;

use std::rc::Rc;

use letterbox_protocol::{
    AccountId, ChangeId, ChangeResult, CoreMessage, MessageId, Refusal, Time, Unsubscribe, UnsubscribeMethod,
    Unsubscribed,
};
use serde::{Deserialize, Serialize};
use tokio::task::spawn_local;

use crate::Inner;
use crate::adapter::RawResult;
use crate::body::unsubscribe::without_one_click;
use crate::body::unsubscribe_of;
use crate::clock::parse;
use crate::draft::prepare;
use crate::effect::Effect;
use crate::outbox;
use crate::sync::Pull;
use crate::web::Posted;
use crate::world::{ChangeOutcome, ChangeRecord, World, put_change, scoped};

/// The most of a message's raw source the core reads for its DKIM check. A signature covers the
/// headers and a hash of the body, so the body must be read whole: a larger message, which its
/// attachments make, goes out another way.
const RAW_LIMIT: usize = 2 * 1024 * 1024;

/// An unsubscribe on its way, as its change carries it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Unsubscription {
    /// The message the user unsubscribed from. Its headers name the ways.
    pub message_id: MessageId,
    /// Its From address, as written. Updates shows the state on that sender's row.
    pub address: String,
    /// The way picked when the user confirmed.
    pub way: Way,
    pub stage: Stage,
}

/// One way to unsubscribe, as the message's headers or body named it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "method", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum Way {
    OneClick { url: String },
    Mailto { uri: String },
    Web { url: String },
}

impl Way {
    fn method(&self) -> UnsubscribeMethod {
        match self {
            Way::OneClick { .. } => UnsubscribeMethod::OneClick,
            Way::Mailto { .. } => UnsubscribeMethod::Mailto,
            Way::Web { .. } => UnsubscribeMethod::Web,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "stage", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum Stage {
    /// In its undo window until `until`. `undo` cancels it.
    Held { until: Time },
    /// Out of its window, and nothing has gone out. A job in the account's queue carries it out.
    Due,
    /// A POST to `url` has started. Saved before the call, so a core that stops during it
    /// finds it here and never sends it again.
    Posting { url: String },
    /// Only its page is left, kept for the user to open. It settled done in the same commit.
    Page { url: String },
}

impl Unsubscription {
    /// The way it goes out by, from where it has got.
    fn method(&self) -> UnsubscribeMethod {
        match self.stage {
            Stage::Posting { .. } => UnsubscribeMethod::OneClick,
            Stage::Page { .. } => UnsubscribeMethod::Web,
            Stage::Held { .. } | Stage::Due => self.way.method(),
        }
    }
}

/// The key of a sender in `World::unsubscribes`: its account and its address, lowercase.
pub fn sender_key(account_id: &AccountId, address: &str) -> String {
    scoped(account_id, &address.to_lowercase())
}

/// Where the newest unsubscribe from `address` in an account has got, for its row in Updates.
/// None when there is none, or it was undone or failed.
pub fn state(world: &World, account_id: &AccountId, address: &str) -> Option<Unsubscribed> {
    let id = world.unsubscribes.get(&sender_key(account_id, address))?;
    let record = world.changes.get(id)?;
    let change = record.id.clone();
    let (method, stage) = match &record.effect {
        Effect::Unsubscribe(unsubscription) => (unsubscription.method(), Some(&unsubscription.stage)),
        // It went out as mail (see `mail`).
        Effect::Send(_) => (UnsubscribeMethod::Mailto, None),
        _ => return None,
    };
    match (record.outcome.map(|outcome| outcome.result), stage) {
        (Some(ChangeResult::Done), Some(Stage::Page { url })) => Some(Unsubscribed::Page {
            change,
            url: url.clone(),
        }),
        (Some(ChangeResult::Done), _) => Some(Unsubscribed::Done { change, method }),
        (Some(_), _) => None,
        (None, Some(Stage::Held { until })) => Some(Unsubscribed::Held {
            change,
            until: until.clone(),
            method,
        }),
        (None, _) => Some(Unsubscribed::Sending { change, method }),
    }
}

/// The unsubscribe the user asks for from `message_id`'s sender, before it is stored, or why
/// it is refused (see `Command::Unsubscribe`).
fn plan(world: &World, message_id: &MessageId) -> Result<(AccountId, Unsubscription), Refusal> {
    let record = world.messages.get(message_id).ok_or(Refusal::UnknownTarget)?;
    let account = world.accounts.get(&record.account_id).ok_or(Refusal::UnknownTarget)?;
    let way = match unsubscribe_of(record).ok_or(Refusal::NotSupported)? {
        Unsubscribe::OneClick { url, .. } => Way::OneClick { url },
        Unsubscribe::Mailto { uri, .. } if account.capabilities.send && account.capabilities.modify => {
            Way::Mailto { uri }
        }
        Unsubscribe::Mailto { .. } => return Err(Refusal::NotPermitted),
        Unsubscribe::Web { url, .. } => Way::Web { url },
    };
    let address = record.facts.from.address.clone();
    // One unsubscribe per sender: a new one only when there is none, or the newest was undone
    // or failed (`state` is None for both).
    match state(world, &account.id, &address) {
        Some(Unsubscribed::Held { .. } | Unsubscribed::Sending { .. }) => return Err(Refusal::Conflict),
        Some(Unsubscribed::Done { .. } | Unsubscribed::Page { .. }) => return Err(Refusal::AlreadyUnsubscribed),
        None => {}
    }
    let unsubscription = Unsubscription {
        message_id: message_id.clone(),
        address,
        way,
        stage: Stage::Due,
    };
    Ok((account.id.clone(), unsubscription))
}

impl Inner {
    /// Accepts an unsubscribe: stores it held, then starts its undo window.
    pub(crate) fn unsubscribe(self: &Rc<Self>, change: ChangeId, message_id: &MessageId) {
        let planned = plan(&self.state.borrow().world, message_id);
        let (account_id, unsubscription) = match planned {
            Ok(planned) => planned,
            Err(reason) => return self.reject(change, reason),
        };
        let until = self.window_end(&self.env.now());
        let held = Unsubscription {
            stage: Stage::Held { until: until.clone() },
            ..unsubscription
        };
        self.commit_then(
            |world, tx, at| {
                let record = ChangeRecord {
                    id: change.clone(),
                    account_id,
                    effect: Effect::Unsubscribe(held),
                    accepted_rev: at,
                    outcome: None,
                };
                put_change(world, tx, record);
            },
            |rev| self.accepted(&change, rev),
        );
        self.hold_unsubscribe(change, &until);
    }

    /// Answers an undo of an unsubscribe (see undo.rs). Only one still in its window can be
    /// undone: the saved deadline decides, as for a send, not whether its timer has run.
    pub(crate) fn undo_unsubscribe(self: &Rc<Self>, change: ChangeId, record: ChangeRecord) {
        let open = match (&record.effect, record.outcome) {
            (
                Effect::Unsubscribe(Unsubscription {
                    stage: Stage::Held { until },
                    ..
                }),
                None,
            ) => parse(&self.env.now()) < parse(until),
            _ => false,
        };
        if !open {
            return self.reject(change, Refusal::Conflict);
        }
        self.cancel(change, record, |_, _| {});
    }

    /// Picks up every unsubscribe a restart found on its way (see the module docs).
    pub(crate) fn resume_unsubscribes(self: &Rc<Self>) {
        let waiting: Vec<(ChangeRecord, Stage)> = {
            let state = self.state.borrow();
            let pending = state.world.changes.values().filter(|change| change.outcome.is_none());
            pending
                .filter_map(|change| match &change.effect {
                    Effect::Unsubscribe(unsubscription) => Some((change.clone(), unsubscription.stage.clone())),
                    _ => None,
                })
                .collect()
        };
        for (record, stage) in waiting {
            match stage {
                Stage::Held { until } => self.hold_unsubscribe(record.id, &until),
                Stage::Due | Stage::Posting { .. } | Stage::Page { .. } => {
                    self.carry_out(&record.account_id, record.id)
                }
            }
        }
    }

    /// Waits out an unsubscribe's undo window, then carries it out. The wait is not work the
    /// core finishes before it closes: a closing core leaves it held, and the next start resumes it.
    fn hold_unsubscribe(self: &Rc<Self>, change: ChangeId, until: &Time) {
        let window = self.env.until(until);
        let core = Rc::clone(self);
        spawn_local(async move {
            window.await;
            if !core.work.is_closed() {
                core.release_unsubscribe(change);
            }
        });
    }

    /// Ends an unsubscribe's window, unless it was undone, and queues the job that carries it out.
    fn release_unsubscribe(self: &Rc<Self>, change: ChangeId) {
        let Some((record, unsubscription)) = self.pending_unsubscribe(&change) else {
            return;
        };
        if !matches!(unsubscription.stage, Stage::Held { .. }) {
            return;
        }
        let account_id = record.account_id.clone();
        self.restage_unsubscribe(record, &unsubscription, Stage::Due);
        self.carry_out(&account_id, change);
    }

    /// Queues the job that carries an unsubscribe out, after what the account has queued.
    fn carry_out(self: &Rc<Self>, account_id: &AccountId, change: ChangeId) {
        let core = Rc::clone(self);
        self.background(account_id, async move { core.carry(change).await });
    }

    /// The change `change`, while it is an unsubscribe that has not settled.
    fn pending_unsubscribe(&self, change: &ChangeId) -> Option<(ChangeRecord, Unsubscription)> {
        let state = self.state.borrow();
        let record = state
            .world
            .changes
            .get(change)
            .filter(|record| record.outcome.is_none())?;
        match &record.effect {
            Effect::Unsubscribe(unsubscription) => Some((record.clone(), unsubscription.clone())),
            _ => None,
        }
    }

    /// Moves an unsubscribe to `stage` in one commit, and returns its record as stored.
    fn restage_unsubscribe(
        self: &Rc<Self>,
        record: ChangeRecord,
        unsubscription: &Unsubscription,
        stage: Stage,
    ) -> ChangeRecord {
        let effect = Effect::Unsubscribe(Unsubscription {
            stage,
            ..unsubscription.clone()
        });
        let staged = ChangeRecord { effect, ..record };
        self.commit(|world, tx, _| put_change(world, tx, staged.clone()));
        staged
    }

    /// The job `carry_out` queues: carries a due unsubscribe out by its way (see the module docs).
    async fn carry(self: &Rc<Self>, change: ChangeId) {
        let Some((record, unsubscription)) = self.pending_unsubscribe(&change) else {
            return;
        };
        match (&unsubscription.stage, unsubscription.way.clone()) {
            (Stage::Held { .. } | Stage::Page { .. }, _) => {}
            // It may have reached the server before the core stopped.
            (Stage::Posting { .. }, _) => self.settle(record, ChangeResult::Failed(Refusal::Unconfirmed)),
            (Stage::Due, Way::Web { url }) => self.keep_page(record, &unsubscription, url),
            (Stage::Due, Way::Mailto { uri }) => self.mail(record, &unsubscription, &uri),
            (Stage::Due, Way::OneClick { .. }) => {
                let url = self.verified(&record.account_id, &unsubscription.message_id).await;
                // Read again: a sign-out that deleted the account's mail may have taken it meanwhile.
                let Some((record, unsubscription)) = self.pending_unsubscribe(&change) else {
                    return;
                };
                match url {
                    Some(url) => self.post_one_click(record, unsubscription, url).await,
                    None => self.fall_back(record, &unsubscription),
                }
            }
        }
    }

    /// The one-click URL the message's raw source vouches for, or None when the source cannot
    /// be had or no DKIM signature over both headers verifies (dkim.rs). One `raw` call.
    async fn verified(&self, account_id: &AccountId, message_id: &MessageId) -> Option<String> {
        let (adapter, r#ref, from) = {
            let state = self.state.borrow();
            let message = state.world.messages.get(message_id)?;
            let (r#ref, from) = (message.provider_ref()?.clone(), message.facts.from.address.clone());
            (Rc::clone(&state.adapters.get(account_id)?.adapter), r#ref, from)
        };
        let Ok(RawResult::Raw(raw)) = adapter.raw(r#ref, RAW_LIMIT).await else {
            return None;
        };
        let (_, from_domain) = from.rsplit_once('@')?;
        dkim::one_click(&raw, from_domain, self.web.as_ref()).await
    }

    /// POSTs a verified one-click, once, and settles it by the answer.
    async fn post_one_click(self: &Rc<Self>, record: ChangeRecord, unsubscription: Unsubscription, url: String) {
        let posting = Stage::Posting { url: url.clone() };
        let record = self.restage_unsubscribe(record, &unsubscription, posting);
        let posted = self.web.post_one_click(&url).await;
        let Some((record, unsubscription)) = self.pending_unsubscribe(&record.id) else {
            return;
        };
        let result = match posted {
            Posted::Answered { status } if (200..300).contains(&status) => ChangeResult::Done,
            // RFC 8058 section 3.1 forbids a redirect, so it is not followed: the server took
            // the POST and did not say it unsubscribed.
            Posted::Answered { .. } | Posted::Redirect => ChangeResult::Failed(Refusal::RefusedByProvider),
            Posted::Refused => ChangeResult::Failed(Refusal::NotPublic),
            Posted::NoAnswer => ChangeResult::Failed(Refusal::Unconfirmed),
            // It surely did not reach the server, so another way may go.
            Posted::NotSent => return self.fall_back(record, &unsubscription),
        };
        self.settle(record, result);
    }

    /// Carries out an unsubscribe whose one-click cannot be used: as the header's mailto when
    /// the account can send, else as the one-click URL's page.
    fn fall_back(self: &Rc<Self>, record: ChangeRecord, unsubscription: &Unsubscription) {
        let mailto = {
            let state = self.state.borrow();
            let world = &state.world;
            let account = world.accounts.get(&record.account_id);
            let can_send = account.is_some_and(|account| account.capabilities.send && account.capabilities.modify);
            let message = world.messages.get(&unsubscription.message_id).filter(|_| can_send);
            match message.and_then(|message| without_one_click(&message.facts.headers)) {
                Some(Unsubscribe::Mailto { uri, .. }) => Some(uri),
                _ => None,
            }
        };
        match (mailto, &unsubscription.way) {
            (Some(uri), _) => self.mail(record, unsubscription, &uri),
            (None, Way::OneClick { url } | Way::Web { url }) => self.keep_page(record, unsubscription, url.clone()),
            (None, Way::Mailto { .. }) => self.settle(record, ChangeResult::Failed(Refusal::NotPermitted)),
        }
    }

    /// Keeps the page of a web unsubscribe for the user to open, and settles it done in the same
    /// commit. Nothing goes to the shell (see the module docs).
    fn keep_page(self: &Rc<Self>, record: ChangeRecord, unsubscription: &Unsubscription, url: String) {
        let change = record.id.clone();
        let effect = Effect::Unsubscribe(Unsubscription {
            stage: Stage::Page { url },
            ..unsubscription.clone()
        });
        let rev = self.commit(|world, tx, at| {
            let outcome = Some(ChangeOutcome {
                rev: at,
                result: ChangeResult::Done,
            });
            put_change(
                world,
                tx,
                ChangeRecord {
                    effect,
                    outcome,
                    ..record
                },
            );
        });
        let result = ChangeResult::Done;
        self.send(CoreMessage::Settled { change, rev, result });
    }

    /// Turns the unsubscribe into a send of the email `uri` describes, due at once, in one
    /// commit, and queues a pass to deliver it. From then on the outbox carries it, and it
    /// settles as the send does. A URI the core cannot read fails it `invalid`.
    fn mail(self: &Rc<Self>, record: ChangeRecord, unsubscription: &Unsubscription, uri: &str) {
        let now = self.env.now();
        let random = self.env.random();
        let prepared = mailto::draft(&record.account_id, uri)
            .ok_or(Refusal::Invalid)
            .and_then(|draft| prepare(&self.state.borrow().world, &draft, &now, random));
        let prepared = match prepared {
            Ok(prepared) => prepared,
            Err(reason) => return self.settle(record, ChangeResult::Failed(reason)),
        };
        let account_id = record.account_id.clone();
        let sender = Some(unsubscription.address.clone());
        let accepted = Some(record.accepted_rev);
        self.store_send(&record.id, prepared, None, outbox::Stage::Due, sender, accepted, |_| {});
        self.background(&account_id, Rc::clone(self).pass(account_id.clone(), Pull::No));
    }
}
