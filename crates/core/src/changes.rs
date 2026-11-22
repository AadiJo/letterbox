//! A user's action from the moment it is accepted until the provider has it.
//!
//! A command names threads. It is resolved once into an Op that names messages
//! and absolute values. The Op is laid over what the provider last reported to
//! get what the user sees, and later turned into mutations for the adapter.
//! When an Op is dropped, what the user sees falls back to the provider's state
//! with no extra work. That is how a refused change is undone.

use std::borrow::Cow;

use letterbox_protocol::{AccountId, Command, MailboxId, MessageId, Refusal, Role, ThreadId};

use crate::adapter::{MailboxRef, Mutation};
use crate::maps::{HashMap, IndexMap};
use crate::world::{AccountRecord, MailboxMode, MailboxRecord, MessageRecord, MessageState, Op, World};

/// Lays one Op over a message's state. Returns the state unchanged if the Op does not name the message.
pub fn overlay(state: &MessageState, op: &Op, id: &MessageId) -> MessageState {
    if !op.message_ids().contains(id) {
        return state.clone();
    }
    match op {
        Op::Flags { unread, flagged, .. } => MessageState {
            mailboxes: state.mailboxes.clone(),
            unread: unread.unwrap_or(state.unread),
            flagged: flagged.unwrap_or(state.flagged),
        },
        Op::Mailboxes {
            mode: MailboxMode::Move,
            add,
            remove,
            ..
        } => match add.first() {
            Some(destination) if state.mailboxes.iter().any(|mailbox| remove.contains(mailbox)) => MessageState {
                mailboxes: vec![destination.clone()],
                ..state.clone()
            },
            _ => state.clone(),
        },
        Op::Mailboxes {
            mode: MailboxMode::Sets,
            add,
            remove,
            ..
        } => {
            let kept: Vec<&MailboxId> = state
                .mailboxes
                .iter()
                .filter(|mailbox| !remove.contains(mailbox))
                .collect();
            let added = add.iter().filter(|mailbox| !kept.contains(mailbox));
            MessageState {
                mailboxes: kept.iter().copied().chain(added).cloned().collect(),
                ..state.clone()
            }
        }
    }
}

/// Every change that has been accepted and not settled, indexed by the messages it names.
/// Views build one per answer, so a message no change names costs one lookup and no copy.
pub struct Pending<'a> {
    /// For each message, the Ops that name it, oldest first. A send names its message with no
    /// Op: it changes no state, and its message shows from the moment it is accepted.
    by_message: HashMap<&'a MessageId, Vec<&'a Op>>,
}

impl<'a> Pending<'a> {
    pub fn of(world: &'a World) -> Self {
        let mut by_message: HashMap<&MessageId, Vec<&Op>> = HashMap::default();
        let waiting = world.changes.values().filter(|change| change.outcome.is_none());
        for effect in waiting.map(|change| &change.effect) {
            for id in effect.named() {
                by_message.entry(id).or_default();
            }
            for op in effect.ops() {
                for id in op.message_ids() {
                    let named = by_message.entry(id).or_default();
                    // An Op that names a message twice is laid over it once, as overlay does.
                    if !named.last().is_some_and(|last| std::ptr::eq(*last, op)) {
                        named.push(op);
                    }
                }
            }
        }
        Pending { by_message }
    }

    /// True when a change that has not settled names this message.
    pub fn touches(&self, id: &MessageId) -> bool {
        self.by_message.contains_key(id)
    }

    /// What the user sees for one message: the provider's state with pending changes on top.
    /// Borrows the stored state when no change names the message.
    pub fn view_state(&self, record: &'a MessageRecord) -> Cow<'a, MessageState> {
        match self.by_message.get(&record.id) {
            None => Cow::Borrowed(&record.server),
            Some(ops) => Cow::Owned(
                ops.iter()
                    .fold(record.server.clone(), |state, op| overlay(&state, op, &record.id)),
            ),
        }
    }
}

/// The threads a command names that exist, and the one account they belong to.
pub struct Targets {
    pub account_id: AccountId,
    pub thread_ids: Vec<ThreadId>,
}

pub fn targets(world: &World, thread_ids: &[ThreadId]) -> Result<Targets, Refusal> {
    let found: Vec<_> = thread_ids.iter().filter_map(|id| world.threads.get(id)).collect();
    let first = found.first().ok_or(Refusal::UnknownTarget)?;
    if found.iter().any(|thread| thread.account_id != first.account_id) {
        return Err(Refusal::Invalid);
    }
    Ok(Targets {
        account_id: first.account_id.clone(),
        thread_ids: found.iter().map(|thread| thread.id.clone()).collect(),
    })
}

/// What a command that reaches the provider asks for, apart from the threads it names.
/// Set-turn, which the core answers on its own, send, which the outbox answers (see
/// outbox.rs), and undo (see undo.rs) have no Edit.
pub enum Edit<'a> {
    Flags {
        unread: Option<bool>,
        flagged: Option<bool>,
    },
    Mailboxes {
        add: &'a [MailboxId],
        remove: &'a [MailboxId],
    },
    Trash,
}

impl<'a> Edit<'a> {
    /// The threads a command names and the Edit it asks for, or None for a command that
    /// never reaches the provider.
    pub fn of(command: &'a Command) -> Option<(&'a [ThreadId], Edit<'a>)> {
        match command {
            Command::SetFlags {
                thread_ids,
                unread,
                flagged,
            } => Some((
                thread_ids,
                Edit::Flags {
                    unread: *unread,
                    flagged: *flagged,
                },
            )),
            Command::SetMailboxes {
                thread_ids,
                add,
                remove,
            } => Some((thread_ids, Edit::Mailboxes { add, remove })),
            Command::Trash { thread_ids } => Some((thread_ids, Edit::Trash)),
            Command::SetTurn { .. } | Command::SetImages { .. } | Command::Send { .. } | Command::Undo { .. } => None,
        }
    }
}

/// How an account's mailboxes change: by sets where a message can be in several, else by moves.
pub fn mode_of(account: &AccountRecord) -> MailboxMode {
    if account.capabilities.multiple_mailboxes {
        MailboxMode::Sets
    } else {
        MailboxMode::Move
    }
}

/// Turns an Edit of some threads into an Op, or says why it cannot be done on this account.
pub fn resolve(world: &World, thread_ids: &[ThreadId], edit: Edit<'_>) -> Result<(AccountId, Op), Refusal> {
    let target = targets(world, thread_ids)?;
    let account = world.accounts.get(&target.account_id).ok_or(Refusal::UnknownTarget)?;
    if !account.capabilities.modify {
        return Err(Refusal::NotPermitted);
    }

    let message_ids: Vec<MessageId> = target
        .thread_ids
        .iter()
        .flat_map(|id| world.messages_by_thread.get(id).into_iter().flatten().cloned())
        .collect();
    let own: Vec<_> = world
        .mailboxes
        .values()
        .filter(|mailbox| mailbox.account_id == account.id)
        .collect();
    let with_role = |role: Role| {
        own.iter()
            .find(|mailbox| mailbox.role == Some(role))
            .map(|mailbox| mailbox.id.clone())
    };
    let mode = mode_of(account);
    let mailboxes = |add: Vec<MailboxId>, remove: Vec<MailboxId>| {
        Ok((
            account.id.clone(),
            Op::Mailboxes {
                mode,
                message_ids: message_ids.clone(),
                add,
                remove,
            },
        ))
    };

    match edit {
        Edit::Flags { unread, flagged } => {
            if unread.is_none() && flagged.is_none() {
                return Err(Refusal::Invalid);
            }
            Ok((
                account.id.clone(),
                Op::Flags {
                    message_ids: message_ids.clone(),
                    unread,
                    flagged,
                },
            ))
        }
        Edit::Trash => {
            let trash = with_role(Role::Trash).ok_or(Refusal::NotSupported)?;
            // With labels the provider sets Sent and Drafts itself, and Gmail takes neither off
            // a message. A trash that took them off would record what never happens, and its
            // undo would read the provider keeping them as a change made since (undo.rs).
            let provider_set = |mailbox: &MailboxRecord| {
                mode == MailboxMode::Sets && matches!(mailbox.role, Some(Role::Sent | Role::Drafts))
            };
            let others = own
                .iter()
                .filter(|mailbox| mailbox.id != trash && !provider_set(mailbox))
                .map(|mailbox| mailbox.id.clone())
                .collect();
            mailboxes(vec![trash], others)
        }
        Edit::Mailboxes { add, remove } => {
            let mut named = add.iter().chain(remove);
            if add.is_empty() && remove.is_empty() {
                return Err(Refusal::Invalid);
            }
            if named.any(|id| world.mailboxes.get(id).map(|mailbox| &mailbox.account_id) != Some(&account.id)) {
                return Err(Refusal::UnknownTarget);
            }
            if mode == MailboxMode::Sets {
                return mailboxes(add.to_vec(), remove.to_vec());
            }
            // Plain folders: a message is in one place, so every change is a move out of `remove`.
            if add.len() > 1 || remove.is_empty() {
                return Err(Refusal::NotSupported);
            }
            match add.first().cloned().or_else(|| with_role(Role::Archive)) {
                Some(destination) => mailboxes(vec![destination], remove.to_vec()),
                None => Err(Refusal::NotSupported),
            }
        }
    }
}

/// One adapter call that carries part of an Op, and the part of the Op it carries.
pub struct Step {
    pub mutation: Mutation,
    pub message_ids: Vec<MessageId>,
    pub part: Op,
}

/// The adapter calls that carry a change's Ops to the provider, in order. None when every
/// message they name is gone. A send has no Ops: the outbox delivers it whole (see outbox.rs).
pub fn plan(world: &World, ops: &[Op]) -> Option<Vec<Step>> {
    let planned: Vec<Vec<Step>> = ops.iter().filter_map(|op| plan_one(world, op)).collect();
    (!planned.is_empty()).then(|| planned.into_iter().flatten().collect())
}

/// The adapter calls that carry one Op to the provider, worked out from what
/// the provider holds now. A message that is already where the Op puts it is
/// left out, so pushing the same Op again after a restart does no harm. Messages
/// still in the outbox are left out too: the provider does not hold them.
/// None when every message the Op names is gone.
fn plan_one(world: &World, op: &Op) -> Option<Vec<Step>> {
    let records: Vec<&MessageRecord> = op
        .message_ids()
        .iter()
        .filter_map(|id| world.messages.get(id))
        .filter(|record| record.provider_ref().is_some())
        .collect();
    if records.is_empty() {
        return None;
    }
    let refs = records
        .iter()
        .filter_map(|record| record.provider_ref().cloned())
        .collect();
    let message_ids: Vec<MessageId> = records.iter().map(|record| record.id.clone()).collect();
    let mailbox_refs = |ids: &[MailboxId]| -> Vec<MailboxRef> {
        ids.iter()
            .filter_map(|id| world.mailboxes.get(id).map(|mailbox| mailbox.r#ref.clone()))
            .collect()
    };

    match op {
        Op::Flags { unread, flagged, .. } => Some(vec![Step {
            mutation: Mutation::Flags {
                refs,
                unread: *unread,
                flagged: *flagged,
            },
            part: Op::Flags {
                message_ids: message_ids.clone(),
                unread: *unread,
                flagged: *flagged,
            },
            message_ids,
        }]),
        Op::Mailboxes {
            mode: MailboxMode::Sets,
            add,
            remove,
            ..
        } => Some(vec![Step {
            mutation: Mutation::Mailboxes {
                refs,
                add: mailbox_refs(add),
                remove: mailbox_refs(remove),
            },
            part: Op::Mailboxes {
                mode: MailboxMode::Sets,
                message_ids: message_ids.clone(),
                add: add.clone(),
                remove: remove.clone(),
            },
            message_ids,
        }]),
        Op::Mailboxes {
            mode: MailboxMode::Move,
            add,
            remove,
            ..
        } => {
            // One move per folder the messages are leaving.
            let mut by_source: IndexMap<&MailboxId, Vec<&MessageRecord>> = IndexMap::default();
            for record in &records {
                let source = record.server.mailboxes.iter().find(|mailbox| remove.contains(mailbox));
                if let Some(source) = source
                    && Some(source) != add.first()
                {
                    by_source.entry(source).or_default().push(record);
                }
            }
            let steps = by_source
                .into_iter()
                .map(|(source, group)| {
                    let ids: Vec<MessageId> = group.iter().map(|record| record.id.clone()).collect();
                    Step {
                        mutation: Mutation::Mailboxes {
                            refs: group
                                .iter()
                                .filter_map(|record| record.provider_ref().cloned())
                                .collect(),
                            add: mailbox_refs(add),
                            remove: mailbox_refs(std::slice::from_ref(source)),
                        },
                        part: Op::Mailboxes {
                            mode: MailboxMode::Move,
                            message_ids: ids.clone(),
                            add: add.clone(),
                            remove: vec![source.clone()],
                        },
                        message_ids: ids,
                    }
                })
                .collect();
            Some(steps)
        }
    }
}
