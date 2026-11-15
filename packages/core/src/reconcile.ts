// Brings the world in line with what an adapter reported. One function takes
// both a full snapshot and a set of changes, so both follow the same rules.
//
// A provider may give a message a new ref when it moves, or renumber every
// message at once. A message that seems to vanish and reappear in the same
// report is matched by its fingerprint, so it keeps its id, its thread, its
// body and any turn the user set.

import type { AccountId, MailboxId, MessageId, ThreadId } from '@letterbox/protocol'
import type { MailboxRef, MessageRef, RemoteFacts, RemoteMailbox, RemoteMessage, RemoteState } from './adapter.ts'
import {
  type AccountRecord,
  type MessageRecord,
  type MessageState,
  messagesOf,
  putMailbox,
  putMessage,
  putThread,
  removeMailbox,
  removeMessage,
  removeThread,
  scoped,
  type Transaction,
  type World,
} from './world.ts'

export type Incoming = {
  /** True when `added` is the whole mailbox. Anything not in it is gone. */
  full: boolean
  mailboxes: RemoteMailbox[] | null
  added: RemoteMessage[]
  updated: RemoteState[]
  removed: MessageRef[]
}

/** Facts that stay the same when a provider gives a message a new ref. */
const fingerprint = (facts: RemoteFacts) =>
  [facts.messageId ?? '', facts.sentAt, facts.size, facts.from.address, facts.subject].join('\n')

/** A subject with reply and forward prefixes removed, for comparing. */
export const normalizeSubject = (subject: string) =>
  subject
    .replace(/^(\s*(re|fwd?|aw|sv|antw)\s*:)+/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()

/** When the oldest message of a thread was sent. */
const oldestIn = (world: World, id: ThreadId) => messagesOf(world, id)[0]?.facts.sentAt ?? ''

/** Splits a remote message into the two halves the record keeps apart. */
const factsOf = ({
  ref: _ref,
  mailboxes: _mailboxes,
  unread: _unread,
  flagged: _flagged,
  ...facts
}: RemoteMessage): RemoteFacts => facts

/**
 * Picks the thread a new message belongs to, merging threads it connects.
 * Two messages share a thread when one names the other in its reply chain, or
 * they are copies with the same Message-ID, and their subjects match.
 */
function threadFor(world: World, tx: Transaction, accountId: AccountId, facts: RemoteFacts): ThreadId {
  const subject = normalizeSubject(facts.subject)
  const related = new Set<MessageId>()
  for (const reference of facts.references) {
    for (const id of world.messagesByMessageId.get(scoped(accountId, reference)) ?? []) related.add(id)
  }
  if (facts.messageId) {
    for (const id of world.messagesByMessageId.get(scoped(accountId, facts.messageId)) ?? []) related.add(id)
    for (const id of world.messagesByReference.get(scoped(accountId, facts.messageId)) ?? []) related.add(id)
  }

  const threads = new Set<ThreadId>()
  for (const id of related) {
    const record = world.messages.get(id)
    if (record && normalizeSubject(record.facts.subject) === subject) threads.add(record.threadId)
  }
  if (threads.size === 0) {
    const id = world.store.nextId('threads')
    putThread(world, tx, { id, accountId, override: null })
    return id
  }

  // The thread holding the oldest message survives a merge, so ids stay stable as mail arrives.
  const [winner, ...losers] = [...threads].toSorted(
    (a, b) => oldestIn(world, a).localeCompare(oldestIn(world, b)) || a.localeCompare(b),
  )
  if (!winner) throw new Error('a non-empty set of threads has a first member')
  for (const loser of losers) {
    for (const record of messagesOf(world, loser)) putMessage(world, tx, { ...record, threadId: winner }, record)
    const kept = world.threads.get(winner)
    const override = world.threads.get(loser)?.override ?? null
    if (kept && !kept.override && override) putThread(world, tx, { ...kept, override })
    removeThread(world, tx, loser)
  }
  return winner
}

/** Applies one report from an adapter to the world, inside the caller's transaction. */
export function reconcile(world: World, tx: Transaction, account: AccountRecord, incoming: Incoming) {
  if (incoming.mailboxes) {
    const seen = new Set<MailboxId>()
    for (const remote of incoming.mailboxes) {
      const id = world.mailboxByRef.get(scoped(account.id, remote.ref)) ?? world.store.nextId('mailboxes')
      seen.add(id)
      putMailbox(world, tx, {
        id,
        accountId: account.id,
        ref: remote.ref,
        name: remote.name,
        role: remote.role,
        parent: remote.parent,
      })
    }
    for (const record of world.mailboxes.values()) {
      if (record.accountId === account.id && !seen.has(record.id)) removeMailbox(world, tx, record)
    }
  }

  const mailboxIds = (refs: MailboxRef[]) =>
    refs.flatMap((ref) => world.mailboxByRef.get(scoped(account.id, ref)) ?? [])
  const stateOf = (remote: RemoteState): MessageState => ({
    mailboxes: mailboxIds(remote.mailboxes),
    unread: remote.unread,
    flagged: remote.flagged,
  })
  const known = (ref: MessageRef) => {
    const id = world.messageByRef.get(scoped(account.id, ref))
    return id ? world.messages.get(id) : undefined
  }

  // Messages the provider no longer lists under their old ref. Some will turn out to have moved.
  const vanished = new Map<MessageId, MessageRecord>()
  if (incoming.full) {
    const listed = new Set(incoming.added.map((remote) => remote.ref))
    for (const record of world.messages.values()) {
      if (record.accountId === account.id && !listed.has(record.ref)) vanished.set(record.id, record)
    }
  }
  for (const ref of incoming.removed) {
    const record = known(ref)
    if (record) vanished.set(record.id, record)
  }

  for (const remote of incoming.added) {
    const existing = known(remote.ref)
    if (existing && !vanished.has(existing.id)) {
      putMessage(world, tx, { ...existing, server: stateOf(remote) }, existing)
      continue
    }
    const facts = factsOf(remote)
    const print = fingerprint(facts)
    const moved = [...vanished.values()].find((record) => fingerprint(record.facts) === print)
    if (moved) {
      vanished.delete(moved.id)
      putMessage(world, tx, { ...moved, ref: remote.ref, server: stateOf(remote) }, moved)
      continue
    }
    const record: MessageRecord = {
      id: world.store.nextId('messages'),
      accountId: account.id,
      ref: remote.ref,
      threadId: threadFor(world, tx, account.id, facts),
      facts,
      server: stateOf(remote),
      body: null,
    }
    putMessage(world, tx, record)
  }

  for (const remote of incoming.updated) {
    const existing = known(remote.ref)
    if (existing && !vanished.has(existing.id))
      putMessage(world, tx, { ...existing, server: stateOf(remote) }, existing)
  }

  for (const record of vanished.values()) {
    removeMessage(world, tx, record)
    if (!world.messagesByThread.has(record.threadId)) removeThread(world, tx, record.threadId)
  }
}
