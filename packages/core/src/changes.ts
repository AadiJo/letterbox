// A user's action from the moment it is accepted until the provider has it.
//
// A command names threads. It is resolved once into an Op that names messages
// and absolute values. The Op is laid over what the provider last reported to
// get what the user sees, and later turned into mutations for the adapter.
// When an Op is dropped, what the user sees falls back to the provider's state
// with no extra work. That is how a refused change is undone.

import type { AccountId, Command, MailboxId, MessageId, Refusal, ThreadId } from '@letterbox/protocol'
import type { Mutation } from './adapter.ts'
import type { MessageRecord, MessageState, Op, World } from './world.ts'

/** Lays one Op over a message's state. Returns the state unchanged if the Op does not name the message. */
export function overlay(state: MessageState, op: Op, id: MessageId): MessageState {
  if (!op.messageIds.includes(id)) return state
  if (op.kind === 'flags') return { ...state, unread: op.unread ?? state.unread, flagged: op.flagged ?? state.flagged }
  if (op.mode === 'move') {
    const destination = op.add[0]
    return destination && state.mailboxes.some((mailbox) => op.remove.includes(mailbox))
      ? { ...state, mailboxes: [destination] }
      : state
  }
  const kept = state.mailboxes.filter((mailbox) => !op.remove.includes(mailbox))
  return { ...state, mailboxes: [...kept, ...op.add.filter((mailbox) => !kept.includes(mailbox))] }
}

/** Every Op that has been accepted and not settled, oldest first. */
export const pendingOps = (world: World): Op[] =>
  [...world.changes.values()].flatMap((change) => (change.outcome === null && change.op ? [change.op] : []))

/** What the user sees for one message: the provider's state with pending changes on top. */
export const viewState = (record: MessageRecord, pending: Op[]): MessageState =>
  pending.reduce((state, op) => overlay(state, op, record.id), record.server)

export type Resolved = { ok: true; accountId: AccountId; op: Op } | { ok: false; reason: Refusal }

const refuse = (reason: Refusal): Resolved => ({ ok: false, reason })

/** The threads a command names that exist, and the one account they belong to. */
export function targets(
  world: World,
  threadIds: ThreadId[],
): { ok: true; accountId: AccountId; threadIds: ThreadId[] } | { ok: false; reason: Refusal } {
  const found = threadIds.flatMap((id) => world.threads.get(id) ?? [])
  const first = found[0]
  if (!first) return { ok: false, reason: 'unknown-target' }
  if (found.some((thread) => thread.accountId !== first.accountId)) return { ok: false, reason: 'invalid' }
  return { ok: true, accountId: first.accountId, threadIds: found.map((thread) => thread.id) }
}

/** Turns a command into an Op, or says why it cannot be done on this account. */
export function resolve(world: World, command: Exclude<Command, { kind: 'set-turn' }>): Resolved {
  if (command.kind === 'send' || command.kind === 'undo') return refuse('not-supported')
  const target = targets(world, command.threadIds)
  if (!target.ok) return target
  const account = world.accounts.get(target.accountId)
  if (!account) return refuse('unknown-target')
  if (!account.capabilities.modify) return refuse('not-permitted')

  const messageIds = target.threadIds.flatMap((id) => Array.from(world.messagesByThread.get(id) ?? []))
  const own = [...world.mailboxes.values()].filter((mailbox) => mailbox.accountId === account.id)
  const withRole = (role: 'archive' | 'trash') => own.find((mailbox) => mailbox.role === role)?.id
  const mode = account.capabilities.multipleMailboxes ? 'sets' : 'move'
  const mailboxes = (add: MailboxId[], remove: MailboxId[]): Resolved => ({
    ok: true,
    accountId: account.id,
    op: { kind: 'mailboxes', mode, messageIds, add, remove },
  })

  if (command.kind === 'set-flags') {
    if (command.unread === undefined && command.flagged === undefined) return refuse('invalid')
    return {
      ok: true,
      accountId: account.id,
      op: {
        kind: 'flags',
        messageIds,
        ...(command.unread !== undefined && { unread: command.unread }),
        ...(command.flagged !== undefined && { flagged: command.flagged }),
      },
    }
  }

  if (command.kind === 'trash') {
    const trash = withRole('trash')
    if (!trash) return refuse('not-supported')
    return mailboxes(
      [trash],
      own.flatMap((mailbox) => (mailbox.id === trash ? [] : mailbox.id)),
    )
  }

  const named = [...command.add, ...command.remove]
  if (named.length === 0) return refuse('invalid')
  if (named.some((id) => world.mailboxes.get(id)?.accountId !== account.id)) return refuse('unknown-target')
  if (mode === 'sets') return mailboxes(command.add, command.remove)

  // Plain folders: a message is in one place, so every change is a move out of `remove`.
  if (command.add.length > 1 || command.remove.length === 0) return refuse('not-supported')
  const destination = command.add[0] ?? withRole('archive')
  return destination ? mailboxes([destination], command.remove) : refuse('not-supported')
}

export type Step = { mutation: Mutation; messageIds: MessageId[]; part: Op }

/**
 * The adapter calls that carry one Op to the provider, worked out from what
 * the provider holds now. A message that is already where the Op puts it is
 * left out, so pushing the same Op again after a restart does no harm.
 * `exists` is false when every message the Op names is gone.
 */
export function plan(world: World, op: Op): { exists: boolean; steps: Step[] } {
  const records = op.messageIds.flatMap((id) => world.messages.get(id) ?? [])
  if (records.length === 0) return { exists: false, steps: [] }
  const refs = records.map((record) => record.ref)
  const messageIds = records.map((record) => record.id)
  const mailboxRefs = (ids: MailboxId[]) => ids.flatMap((id) => world.mailboxes.get(id)?.ref ?? [])

  if (op.kind === 'flags') {
    const flags = {
      ...(op.unread !== undefined && { unread: op.unread }),
      ...(op.flagged !== undefined && { flagged: op.flagged }),
    }
    return {
      exists: true,
      steps: [{ mutation: { kind: 'flags', refs, ...flags }, messageIds, part: { ...op, messageIds } }],
    }
  }
  if (op.mode === 'sets') {
    const mutation: Mutation = { kind: 'mailboxes', refs, add: mailboxRefs(op.add), remove: mailboxRefs(op.remove) }
    return { exists: true, steps: [{ mutation, messageIds, part: { ...op, messageIds } }] }
  }

  // One move per folder the messages are leaving.
  const bySource = new Map<MailboxId, MessageRecord[]>()
  for (const record of records) {
    const source = record.server.mailboxes.find((mailbox) => op.remove.includes(mailbox))
    if (source && source !== op.add[0]) bySource.set(source, [...(bySource.get(source) ?? []), record])
  }
  const steps = [...bySource].map(([source, group]): Step => {
    const ids = group.map((record) => record.id)
    return {
      mutation: {
        kind: 'mailboxes',
        refs: group.map((record) => record.ref),
        add: mailboxRefs(op.add),
        remove: mailboxRefs([source]),
      },
      messageIds: ids,
      part: { ...op, messageIds: ids, remove: [source] },
    }
  })
  return { exists: true, steps }
}
