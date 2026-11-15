//! A user's action from the moment it is accepted until the provider has it.
//!
//! A command names threads. It is resolved once into an Op that names messages
//! and absolute values. The Op is laid over what the provider last reported to
//! get what the user sees, and later turned into mutations for the adapter.
//! When an Op is dropped, what the user sees falls back to the provider's state
//! with no extra work. That is how a refused change is undone.

use indexmap::IndexMap;
use letterbox_protocol::{AccountId, Command, MailboxId, MessageId, Refusal, Role, ThreadId};

use crate::adapter::{MailboxRef, Mutation};
use crate::world::{MailboxMode, MessageRecord, MessageState, Op, World};

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

/// Every Op that has been accepted and not settled, oldest first.
pub fn pending_ops(world: &World) -> Vec<&Op> {
    world
        .changes
        .values()
        .filter(|change| change.outcome.is_none())
        .filter_map(|change| change.op.as_ref())
        .collect()
}

/// What the user sees for one message: the provider's state with pending changes on top.
pub fn view_state(record: &MessageRecord, pending: &[&Op]) -> MessageState {
    pending
        .iter()
        .fold(record.server.clone(), |state, op| overlay(&state, op, &record.id))
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

/// Turns a command into an Op, or says why it cannot be done on this account.
/// The core answers set-turn itself and never passes it here.
pub fn resolve(world: &World, command: &Command) -> Result<(AccountId, Op), Refusal> {
    let thread_ids = match command {
        Command::Send { .. } | Command::Undo { .. } => return Err(Refusal::NotSupported),
        Command::SetTurn { .. } => unreachable!("the core answers set-turn without resolving it"),
        Command::SetFlags { thread_ids, .. }
        | Command::SetMailboxes { thread_ids, .. }
        | Command::Trash { thread_ids } => thread_ids,
    };
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
    let mode = if account.capabilities.multiple_mailboxes {
        MailboxMode::Sets
    } else {
        MailboxMode::Move
    };
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

    match command {
        Command::SetFlags { unread, flagged, .. } => {
            if unread.is_none() && flagged.is_none() {
                return Err(Refusal::Invalid);
            }
            Ok((
                account.id.clone(),
                Op::Flags {
                    message_ids: message_ids.clone(),
                    unread: *unread,
                    flagged: *flagged,
                },
            ))
        }
        Command::Trash { .. } => {
            let trash = with_role(Role::Trash).ok_or(Refusal::NotSupported)?;
            let others = own
                .iter()
                .filter(|mailbox| mailbox.id != trash)
                .map(|mailbox| mailbox.id.clone())
                .collect();
            mailboxes(vec![trash], others)
        }
        Command::SetMailboxes { add, remove, .. } => {
            let mut named = add.iter().chain(remove);
            if add.is_empty() && remove.is_empty() {
                return Err(Refusal::Invalid);
            }
            if named.any(|id| world.mailboxes.get(id).map(|mailbox| &mailbox.account_id) != Some(&account.id)) {
                return Err(Refusal::UnknownTarget);
            }
            if mode == MailboxMode::Sets {
                return mailboxes(add.clone(), remove.clone());
            }
            // Plain folders: a message is in one place, so every change is a move out of `remove`.
            if add.len() > 1 || remove.is_empty() {
                return Err(Refusal::NotSupported);
            }
            match add.first().cloned().or_else(|| with_role(Role::Archive)) {
                Some(destination) => mailboxes(vec![destination], remove.clone()),
                None => Err(Refusal::NotSupported),
            }
        }
        Command::Send { .. } | Command::Undo { .. } | Command::SetTurn { .. } => {
            unreachable!("answered before the account was looked up")
        }
    }
}

/// One adapter call that carries part of an Op, and the part of the Op it carries.
pub struct Step {
    pub mutation: Mutation,
    pub message_ids: Vec<MessageId>,
    pub part: Op,
}

/// The adapter calls that carry one Op to the provider, worked out from what
/// the provider holds now. A message that is already where the Op puts it is
/// left out, so pushing the same Op again after a restart does no harm.
/// None when every message the Op names is gone.
pub fn plan(world: &World, op: &Op) -> Option<Vec<Step>> {
    let records: Vec<&MessageRecord> = op
        .message_ids()
        .iter()
        .filter_map(|id| world.messages.get(id))
        .collect();
    if records.is_empty() {
        return None;
    }
    let refs = records.iter().map(|record| record.r#ref.clone()).collect();
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
            let mut by_source: IndexMap<&MailboxId, Vec<&MessageRecord>> = IndexMap::new();
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
                            refs: group.iter().map(|record| record.r#ref.clone()).collect(),
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
