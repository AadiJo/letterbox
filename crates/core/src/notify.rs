//! Which new mail makes it the user's turn, so a UI can notify (`CoreMessage::YourTurn`).
//!
//! Only a change set brings new mail worth telling: a snapshot lists what the provider holds,
//! which on the first sync, a backfill or a resync is mail the user never waited for. So
//! sync.rs asks here only on the `changes` path, before and after its commit:
//!   - `Inner::arrivals` notes the refs the change set adds that the core does not hold,
//!     and the messages its removed refs name, which a move brings back under a new ref;
//!   - `Inner::tell_your_turns` then finds the messages those refs name that are new, and
//!     sends one `your-turn` for each conversation where the newest of them, in the inbox,
//!     leaves the turn with the user because its sender wrote last (turns.rs).
//!
//! The turn rule already says no for mail from a machine, mail the user is only copied on,
//! and the user's own sends, so this adds only "new", "newest" and "in the inbox".
//!
//! A core that starts over a saved cursor catches up first: its first change set for that
//! account holds the mail that came while the app was quit. Telling each conversation would
//! put a pile of notifications on screen at once, and the badge already counts them, so that
//! change set tells only what the provider says was sent after the core started (`CatchUp`).
//! That first change set can come long after the start, as when `changes` fails until the
//! network is back, and a reply sent meanwhile is still told. Later change sets tell as usual.
//! An account that catches up through a snapshot instead tells from the change set after it.

use std::rc::Rc;

use letterbox_protocol::{AccountId, CoreMessage, MessageId, Role, ThreadId, Time, Turn, TurnReason, YourTurn};

use crate::Inner;
use crate::adapter::{ChangeSet, MessageRef};
use crate::clock::parse;
use crate::maps::{HashSet, IndexMap};
use crate::views::person;
use crate::world::{World, messages_of, scoped};

/// The accounts a started core still catches up for, and when it started. lib.rs keeps it in its state.
pub(crate) struct CatchUp {
    /// The core's clock when it started. Mail sent before it is catch-up mail.
    since: Time,
    /// Signed in with a saved cursor, and no pull since the start.
    accounts: HashSet<AccountId>,
}

impl CatchUp {
    /// The accounts in `world` a core starting at `since` catches up for: signed in, with a
    /// saved cursor, so their first pull is a change set of what came while the app was quit.
    pub(crate) fn starting(world: &World, since: Time) -> CatchUp {
        let resumes = world
            .accounts
            .values()
            .filter(|account| account.signed_in && account.cursor.is_some());
        CatchUp {
            since,
            accounts: resumes.map(|account| account.id.clone()).collect(),
        }
    }
}

/// What a change set may bring that is new, noted before its commit.
pub(crate) struct Arrivals {
    /// Refs it adds that name no message the core holds.
    unknown: Vec<MessageRef>,
    /// The messages its removed refs name. One that comes back under a new ref moved.
    removed: HashSet<MessageId>,
    /// For the change set an account catches up with: only mail sent after this time is new.
    sent_after: Option<Time>,
}

impl Arrivals {
    fn before(world: &World, account_id: &AccountId, set: &ChangeSet, sent_after: Option<Time>) -> Arrivals {
        let held = |r#ref: &MessageRef| world.message_by_ref.get(&scoped(account_id, r#ref.as_str())).cloned();
        let added = set.added.iter().map(|message| &message.state.r#ref);
        Arrivals {
            unknown: added.filter(|r#ref| held(r#ref).is_none()).cloned().collect(),
            removed: set.removed.iter().filter_map(held).collect(),
            sent_after,
        }
    }
}

impl Inner {
    /// Notes, before its commit, what the change set `set` for `account_id` may bring that is
    /// new, for `tell_your_turns` after it. For the change set an account catches up with after
    /// the core starts, only mail sent after the start counts.
    pub(crate) fn arrivals(&self, account_id: &AccountId, set: &ChangeSet) -> Arrivals {
        let mut state = self.state.borrow_mut();
        let catch_up = &mut state.catching_up;
        let sent_after = catch_up.accounts.remove(account_id).then(|| catch_up.since.clone());
        Arrivals::before(&state.world, account_id, set, sent_after)
    }

    /// Notes that `account_id` catches up through a snapshot, which tells nothing anyway, so
    /// the change set after it tells as usual.
    pub(crate) fn caught_up_by_snapshot(&self, account_id: &AccountId) {
        self.state.borrow_mut().catching_up.accounts.remove(account_id);
    }

    /// Sends `your-turn` for each conversation the change set the core just committed for
    /// `account_id` made the user's turn with new mail (see the module docs).
    pub(crate) fn tell_your_turns(self: &Rc<Self>, account_id: &AccountId, arrivals: Arrivals) {
        let told = {
            let state = self.state.borrow();
            let world = &state.world;
            let Some(account) = world.accounts.get(account_id) else {
                return;
            };
            let inbox: HashSet<_> = world
                .mailboxes
                .values()
                .filter(|mailbox| &mailbox.account_id == account_id && mailbox.role == Some(Role::Inbox))
                .map(|mailbox| mailbox.id.clone())
                .collect();
            // In the change set's order, so what is told is the same from run to run. The
            // provider's sent time decides catch-up mail, as it does for the turn rule (turns.rs).
            let after_start = |id: &&MessageId| {
                arrivals.sent_after.as_ref().is_none_or(|since| {
                    world
                        .messages
                        .get(*id)
                        .is_some_and(|record| parse(&record.facts.sent_at) > parse(since))
                })
            };
            let new: Vec<&MessageId> = arrivals
                .unknown
                .iter()
                .filter_map(|r#ref| world.message_by_ref.get(&scoped(account_id, r#ref.as_str())))
                .filter(|id| !arrivals.removed.contains(*id))
                .filter(after_start)
                .collect();
            // Each conversation once, in the order its new mail came.
            let threads: IndexMap<ThreadId, ()> = new
                .iter()
                .filter_map(|id| world.messages.get(*id))
                .map(|record| (record.thread_id.clone(), ()))
                .collect();
            let mut told = Vec::new();
            for thread_id in threads.keys() {
                let turn = state.rows.summary(thread_id).map(|summary| summary.turn);
                if turn.is_none_or(|turn| turn.holder != Turn::Mine || turn.reason != TurnReason::TheyWroteLast) {
                    continue;
                }
                // The turn rule reads only mail the provider holds, so the newest of that is the one it read last.
                let messages = messages_of(world, thread_id);
                let Some(newest) = messages.iter().rev().find(|record| record.provider_ref().is_some()) else {
                    continue;
                };
                if !new.contains(&&newest.id) || !newest.server.mailboxes.iter().any(|id| inbox.contains(id)) {
                    continue;
                }
                told.push(YourTurn {
                    thread_id: thread_id.clone(),
                    from: person(&newest.facts.from, &account.address),
                    subject: newest.facts.subject.clone(),
                });
            }
            told
        };
        for your_turn in told {
            self.send(CoreMessage::YourTurn(your_turn));
        }
    }
}
