// Everything the core knows, held in memory and mirrored to the store.
// Every change to a record goes through a function in this file, which updates
// the lookup tables and writes the record in the caller's transaction.

import type {
  AccountId,
  BlobId,
  ChangeId,
  Mailbox,
  MailboxId,
  MessageId,
  Refusal,
  Rev,
  ThreadId,
  Time,
  Turn,
} from '@letterbox/protocol'
import type {
  AdapterCapabilities,
  AdapterFailure,
  BodyResult,
  Cursor,
  MailboxRef,
  MessageRef,
  RemoteFacts,
} from './adapter.ts'
import type { Store, Transaction as StoreTransaction } from './store.ts'

export type AccountRecord = {
  id: AccountId
  address: string
  providerLabel: string
  /** Which sign-in option made this account, so the right factory can resume it. */
  factoryId: string
  /** Empty after a sign-out that kept the mail. */
  session: string
  capabilities: AdapterCapabilities
  /** Null until the first sync finishes. */
  cursor: Cursor | null
  lastSyncedAt: Time | null
  /** How the last sync pass ended. */
  health: 'ok' | AdapterFailure
}

export type MailboxRecord = {
  id: MailboxId
  accountId: AccountId
  ref: MailboxRef
  name: string
  role: Mailbox['role']
  parent: MailboxRef | null
}

/** The part of a message a user can change. */
export type MessageState = { mailboxes: MailboxId[]; unread: boolean; flagged: boolean }

export type MessageRecord = {
  id: MessageId
  accountId: AccountId
  ref: MessageRef
  threadId: ThreadId
  facts: RemoteFacts
  /** What the provider last reported. Pending changes are laid over this to get what the user sees. */
  server: MessageState
  /** Null until someone opens the message. */
  body: BodyResult | null
}

export type ThreadRecord = {
  id: ThreadId
  accountId: AccountId
  /** A turn the user set by hand. Null leaves it to the rule. */
  override: Turn | null
}

/** A change in the core's own terms: which messages, and what to set on them. */
export type Op =
  | { kind: 'flags'; messageIds: MessageId[]; unread?: boolean; flagged?: boolean }
  /**
   * `sets` adds and removes membership. `move` takes a message that is in one
   * of `remove` and puts it in `add[0]`, for accounts with plain folders.
   */
  | { kind: 'mailboxes'; mode: 'sets' | 'move'; messageIds: MessageId[]; add: MailboxId[]; remove: MailboxId[] }

export type ChangeResult = 'done' | 'undone' | { failed: Refusal }

export type ChangeRecord = {
  id: ChangeId
  accountId: AccountId
  /** Null for a change that never leaves the device. */
  op: Op | null
  acceptedRev: Rev
  /** Null while the change waits to reach the provider. */
  outcome: { rev: Rev; result: ChangeResult } | null
}

/** What each table of the store holds. */
export type Records = {
  accounts: AccountRecord
  mailboxes: MailboxRecord
  messages: MessageRecord
  threads: ThreadRecord
  changes: ChangeRecord
}

export type Transaction = StoreTransaction<Records>

export type World = {
  store: Store<Records>
  accounts: Map<AccountId, AccountRecord>
  mailboxes: Map<MailboxId, MailboxRecord>
  messages: Map<MessageId, MessageRecord>
  threads: Map<ThreadId, ThreadRecord>
  /** In the order they were accepted. */
  changes: Map<ChangeId, ChangeRecord>
  messageByRef: Map<string, MessageId>
  mailboxByRef: Map<string, MailboxId>
  messagesByThread: Map<ThreadId, Set<MessageId>>
  /** Messages by their own Message-ID header. */
  messagesByMessageId: Map<string, Set<MessageId>>
  /** Messages by each Message-ID they reply to. */
  messagesByReference: Map<string, Set<MessageId>>
}

/** The id of one attachment: its message and its place in the message. The only place blob ids are made. */
export const blobIdOf = (messageId: MessageId, index: number) => `blob_${messageId}_${index + 1}` as BlobId

/** A lookup key that is unique across accounts. */
export const scoped = (accountId: AccountId, value: string) => `${accountId}\n${value}`

const addTo = <Key>(index: Map<Key, Set<MessageId>>, key: Key, id: MessageId) => {
  const set = index.get(key) ?? new Set()
  set.add(id)
  index.set(key, set)
}

const dropFrom = <Key>(index: Map<Key, Set<MessageId>>, key: Key, id: MessageId) => {
  const set = index.get(key)
  if (!set) return
  set.delete(id)
  if (set.size === 0) index.delete(key)
}

const index = (world: World, record: MessageRecord) => {
  world.messageByRef.set(scoped(record.accountId, record.ref), record.id)
  addTo(world.messagesByThread, record.threadId, record.id)
  if (record.facts.messageId)
    addTo(world.messagesByMessageId, scoped(record.accountId, record.facts.messageId), record.id)
  for (const reference of record.facts.references)
    addTo(world.messagesByReference, scoped(record.accountId, reference), record.id)
}

const unindex = (world: World, record: MessageRecord) => {
  world.messageByRef.delete(scoped(record.accountId, record.ref))
  dropFrom(world.messagesByThread, record.threadId, record.id)
  if (record.facts.messageId)
    dropFrom(world.messagesByMessageId, scoped(record.accountId, record.facts.messageId), record.id)
  for (const reference of record.facts.references)
    dropFrom(world.messagesByReference, scoped(record.accountId, reference), record.id)
}

/** Loads every record from the store and builds the lookup tables. */
export function loadWorld(store: Store<Records>): World {
  const world: World = {
    store,
    accounts: new Map(store.load('accounts').map((record) => [record.id, record])),
    mailboxes: new Map(store.load('mailboxes').map((record) => [record.id, record])),
    messages: new Map(store.load('messages').map((record) => [record.id, record])),
    threads: new Map(store.load('threads').map((record) => [record.id, record])),
    changes: new Map(store.load('changes').map((record) => [record.id, record])),
    messageByRef: new Map(),
    mailboxByRef: new Map(),
    messagesByThread: new Map(),
    messagesByMessageId: new Map(),
    messagesByReference: new Map(),
  }
  for (const record of world.mailboxes.values()) world.mailboxByRef.set(scoped(record.accountId, record.ref), record.id)
  for (const record of world.messages.values()) index(world, record)
  return world
}

export function putAccount(world: World, tx: Transaction, record: AccountRecord) {
  world.accounts.set(record.id, record)
  tx.put('accounts', record)
}

export function removeAccount(world: World, tx: Transaction, id: AccountId) {
  world.accounts.delete(id)
  tx.remove('accounts', id)
}

export function putMailbox(world: World, tx: Transaction, record: MailboxRecord) {
  world.mailboxes.set(record.id, record)
  world.mailboxByRef.set(scoped(record.accountId, record.ref), record.id)
  tx.put('mailboxes', record)
}

export function removeMailbox(world: World, tx: Transaction, record: MailboxRecord) {
  world.mailboxes.delete(record.id)
  world.mailboxByRef.delete(scoped(record.accountId, record.ref))
  tx.remove('mailboxes', record.id)
}

/** Writes a message. Pass the record it replaces so stale lookups are cleared. */
export function putMessage(world: World, tx: Transaction, record: MessageRecord, replaces?: MessageRecord) {
  if (replaces) unindex(world, replaces)
  world.messages.set(record.id, record)
  index(world, record)
  tx.put('messages', record)
}

export function removeMessage(world: World, tx: Transaction, record: MessageRecord) {
  unindex(world, record)
  world.messages.delete(record.id)
  tx.remove('messages', record.id)
}

export function putThread(world: World, tx: Transaction, record: ThreadRecord) {
  world.threads.set(record.id, record)
  tx.put('threads', record)
}

export function removeThread(world: World, tx: Transaction, id: ThreadId) {
  world.threads.delete(id)
  tx.remove('threads', id)
}

export function putChange(world: World, tx: Transaction, record: ChangeRecord) {
  world.changes.set(record.id, record)
  tx.put('changes', record)
}

export function removeChange(world: World, tx: Transaction, id: ChangeId) {
  world.changes.delete(id)
  tx.remove('changes', id)
}

/** The messages of one thread, oldest first. */
export function messagesOf(world: World, threadId: ThreadId): MessageRecord[] {
  const records: MessageRecord[] = []
  for (const id of world.messagesByThread.get(threadId) ?? []) {
    const record = world.messages.get(id)
    if (record) records.push(record)
  }
  return records.toSorted((a, b) => a.facts.sentAt.localeCompare(b.facts.sentAt) || a.id.localeCompare(b.id))
}
