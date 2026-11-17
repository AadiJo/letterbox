//! Whose turn is it in a conversation? This is the rule the product is built on.
//! It reads only facts every provider can supply, so it gives the same answer
//! for the same mail wherever that mail lives.

use std::sync::LazyLock;

use letterbox_protocol::{ThreadId, Time, Turn, TurnReason, TurnState};
use regex::Regex;

use crate::adapter::RemoteFacts;
use crate::clock::parse;
use crate::world::{ThreadRecord, World, messages_of};

/// What the rule reads from one message.
pub struct TurnMessage {
    pub from_me: bool,
    /// True when I am one of the people the message is addressed to, not only copied.
    pub to_me: bool,
    pub to_addresses: Vec<String>,
    pub automated: bool,
}

static NO_REPLY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(no-?reply|do-?not-?reply|notifications?|mailer-daemon|postmaster|bounces?)\b[^@]*@")
        .expect("a valid pattern")
});

static BULK_PRECEDENCE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)bulk|list|junk").expect("a valid pattern"));

/// True when a machine sent the message: its own headers say so, its address does, or the provider does.
pub fn is_automated(facts: &RemoteFacts) -> bool {
    let headers = &facts.headers;
    facts.bulk == Some(true)
        || headers.list_unsubscribe
        || headers.list_id
        || BULK_PRECEDENCE.is_match(&headers.precedence)
        || (!headers.auto_submitted.is_empty() && headers.auto_submitted.to_lowercase() != "no")
        || NO_REPLY.is_match(&facts.from.address)
}

/// When the newest message the provider holds in a conversation was sent. None while it holds
/// none: a message of mine still in the outbox does not count, as it does not move the turn.
pub fn newest_held(world: &World, thread_id: &ThreadId) -> Option<Time> {
    let records = messages_of(world, thread_id);
    let newest = records.into_iter().rev().find(|record| record.provider_ref().is_some());
    newest.map(|record| record.facts.sent_at.clone())
}

/// A conversation's record with its turn set by the user, or handed back to the rule with None.
/// The turn is set against the conversation as it is now (see `held_override`). Every turn the
/// user sets goes through here: set-turn and its undo (dispatch.rs).
pub fn with_override(world: &World, thread: ThreadRecord, turn: Option<Turn>) -> ThreadRecord {
    let override_since = turn.map(|_| newest_held(world, &thread.id).unwrap_or_default());
    ThreadRecord {
        turn_override: turn,
        override_since,
        ..thread
    }
}

/// The turn the user set on a conversation, while it holds. It holds until the conversation
/// has a message the provider holds that was sent after the newest one it had when they set
/// it: then the conversation moved, and the rule decides again. So their reply to a conversation
/// I marked done makes it my turn, and a message of mine ends it too: the rule then says I am
/// waiting. A message that arrives late but was sent before, as a backfill brings, does not.
/// `newest` is `newest_held`. A turn set before `override_since` was kept holds as it always did.
pub fn held_override(thread: &ThreadRecord, newest: Option<&Time>) -> Option<Turn> {
    let (Some(turn), Some(since)) = (thread.turn_override, &thread.override_since) else {
        return thread.turn_override;
    };
    let moved = newest.is_some_and(|newest| parse(newest) > parse(since));
    (!moved).then_some(turn)
}

/// Decides the turn for one conversation. `messages` is oldest first, and holds only the
/// messages the provider has, so a send of mine moves the turn once it surely went (rows.rs).
/// `turn_override` is the turn the user set, while it holds (`held_override`).
/// The last person to write holds the turn until the other answers. Mail from
/// machines and mail I am only copied on are nobody's turn, and so is a conversation
/// the provider holds nothing of yet: a new message of mine still in the outbox.
pub fn decide_turn(messages: &[TurnMessage], turn_override: Option<Turn>) -> TurnState {
    let decided = |holder, reason| TurnState { holder, reason };
    if let Some(holder) = turn_override {
        return decided(holder, TurnReason::SetByUser);
    }
    let Some(last) = messages.last() else {
        return decided(Turn::Nobody, TurnReason::Automated);
    };

    if last.from_me {
        // I wrote last. I am only waiting if a person could answer.
        let last_from_them = messages.iter().rev().find(|message| !message.from_me);
        let to_machine = last.to_addresses.iter().any(|address| NO_REPLY.is_match(address));
        if to_machine || last_from_them.is_some_and(|message| message.automated) {
            return decided(Turn::Nobody, TurnReason::Automated);
        }
        return decided(Turn::Theirs, TurnReason::IWroteLast);
    }
    if last.automated {
        return decided(Turn::Nobody, TurnReason::Automated);
    }
    if !last.to_me {
        return decided(Turn::Nobody, TurnReason::NotAddressedToMe);
    }
    decided(Turn::Mine, TurnReason::TheyWroteLast)
}
