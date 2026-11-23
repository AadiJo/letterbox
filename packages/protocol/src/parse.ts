// The schema for every message the core sends. The harness checks each one, so the
// Rust core (crates/core) is held to the shapes in protocol.ts. The core reads client
// messages with its own copy of the protocol, crates/protocol.
//
// The schema is written by hand next to the types in protocol.ts. The type check
// below fails the build if the schema and its type ever disagree.

import { type } from 'arktype'
import type { CoreMessage } from './protocol.ts'

const turn = type("'mine' | 'theirs' | 'none'")

/** Replaces every branded id with a plain string, so the schema and the types can be compared. */
type Plain<T> = T extends string
  ? string extends T
    ? string
    : T extends `${infer Literal}`
      ? Literal
      : string
  : T extends readonly (infer Item)[]
    ? Plain<Item>[]
    : T extends object
      ? { [K in keyof T]: Plain<T[K]> }
      : T

/** True only when the two types are the same, down to which fields are optional. */
type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false

/** Rewrites intersections as plain objects so `Same` compares fields, not how a type was written. */
type Flat<T> = T extends readonly (infer Item)[] ? Flat<Item>[] : T extends object ? { [K in keyof T]: Flat<T[K]> } : T

const role = type("'inbox' | 'sent' | 'drafts' | 'archive' | 'trash' | 'spam' | null")
const person = type({ name: 'string | null', address: 'string', isMe: 'boolean' })
const turnReason = type(
  "'they-wrote-last' | 'i-wrote-last' | 'automated' | 'not-addressed-to-me' | 'asks-nothing' | 'set-by-user'",
)
const refusal = type(
  "'not-permitted' | 'not-supported' | 'unknown-target' | 'conflict' | 'refused-by-provider' | 'invalid' | 'unconfirmed'",
)
const undoField = type({ kind: "'mailbox'", messageId: 'string', mailboxId: 'string' })
  .or({ kind: "'unread'", messageId: 'string' })
  .or({ kind: "'flagged'", messageId: 'string' })
  .or({ kind: "'turn'", threadId: 'string' })
const undoConflict = type({ kind: "'changed'", field: undoField })
  .or({ kind: "'partly-applied'", field: undoField })
  .or({ kind: "'outcome-unknown'" })
  .or({ kind: "'mailbox-gone'", mailboxId: 'string' })

const status = type({ state: "'syncing'", done: 'number', total: 'number | null', lastSyncedAt: 'string | null' })
  .or({ state: "'idle'", lastSyncedAt: 'string' })
  .or({ state: "'offline'", lastSyncedAt: 'string | null' })
  .or({ state: "'needs-sign-in'" })
  .or({ state: "'error'", reason: "'provider' | 'storage'", lastSyncedAt: 'string | null' })

const account = type({
  id: 'string',
  address: 'string',
  providerLabel: 'string',
  can: { modify: 'boolean', send: 'boolean', multipleMailboxes: 'boolean' },
  status,
})

const mailbox = type({
  id: 'string',
  accountId: 'string',
  name: 'string',
  role,
  parentId: 'string | null',
  unread: 'number',
  total: 'number',
})

const summaryFields = {
  id: 'string',
  accountId: 'string',
  subject: 'string',
  people: person.array(),
  snippet: 'string',
  lastMessageAt: 'string',
  messageCount: 'number',
  unread: 'boolean',
  flagged: 'boolean',
  hasAttachments: 'boolean',
  mailboxIds: 'string[]',
  turn: { holder: turn, reason: turnReason },
  pending: 'boolean',
} as const

const sender = type({
  id: 'string',
  accountId: 'string',
  name: 'string | null',
  address: 'string',
  threads: 'number',
  messages: 'number',
  unread: 'number',
  subject: 'string',
  lastMessageAt: 'string',
  days: type({ messages: 'number', unread: 'number' }).array(),
})

const body = type({ state: "'ready'", text: 'string', html: 'string | null', hasRemoteContent: 'boolean' })
  .or({ state: "'loading'" })
  .or({ state: "'unavailable'", reason: "'offline' | 'too-large' | 'gone'" })

const delivery = type({ state: "'held'", change: 'string', until: 'string' })
  .or({ state: "'sending'", change: 'string' })
  .or({ state: "'failed'", change: 'string', reason: refusal })

const message = type({
  id: 'string',
  from: person,
  to: person.array(),
  cc: person.array(),
  sentAt: 'string',
  unread: 'boolean',
  body,
  attachments: type({ blobId: 'string', name: 'string', mime: 'string', size: 'number', inline: 'boolean' }).array(),
  delivery: delivery.or('null'),
})

const update = type({ view: "'accounts'", data: account.array() })
  .or({
    view: "'sign-in-options'",
    data: type({ id: 'string', label: 'string', method: "'oauth' | 'password'" }).array(),
  })
  .or({ view: "'mailboxes'", data: mailbox.array() })
  .or({ view: "'threads'", data: { total: 'number', threads: type(summaryFields).array() } })
  .or({ view: "'thread'", data: type({ ...summaryFields, messages: message.array() }).or('null') })
  .or({
    view: "'senders'",
    data: { total: 'number', unreadSenders: 'number', unread: 'number', senders: sender.array() },
  })
  .or({ view: "'recipients'", data: type({ name: 'string | null', address: 'string', lastAt: 'string' }).array() })
  .or({ view: "'change'", data: { threadId: 'string | null' } })

const response = type({ method: "'sign-in'", ok: 'true', result: { accountId: 'string' } })
  .or({
    method: "'sign-in'",
    ok: 'false',
    error: "'cancelled' | 'denied' | 'timed-out' | 'superseded' | 'wrong-password' | 'offline' | 'keychain'",
  })
  .or({ method: "'sign-out'", ok: 'true', result: { '[string]': 'never' } })
  .or({ method: "'sign-out'", ok: 'false', error: 'never' })
  .or({ method: "'sync-now'", ok: 'true', result: { '[string]': 'never' } })
  .or({ method: "'sync-now'", ok: 'false', error: "'offline'" })
  .or({ method: "'blob'", ok: 'true', result: { url: 'string', mime: 'string', size: 'number' } })
  .or({ method: "'blob'", ok: 'false', error: "'offline' | 'gone' | 'not-supported'" })
  .or({ method: "'attachment'", ok: 'true', result: { name: 'string', mime: 'string', size: 'number' } })
  .or({ method: "'attachment'", ok: 'false', error: "'offline' | 'gone' | 'too-large'" })
  .or({ method: "'position'", ok: 'true', result: { offset: 'number | null' } })
  .or({ method: "'position'", ok: 'false', error: 'never' })
  .or({ method: "'network-back'", ok: 'true', result: { '[string]': 'never' } })
  .or({ method: "'network-back'", ok: 'false', error: 'never' })

const coreMessage = type({ kind: "'welcome'", protocol: 'number', rev: 'number' })
  .or(type({ kind: "'update'", sub: 'string', rev: 'number' }).and(update))
  .or({ kind: "'accepted'", change: 'string', rev: 'number' })
  .or({ kind: "'rejected'", change: 'string', reason: refusal, 'conflict?': undoConflict })
  .or({ kind: "'settled'", change: 'string', rev: 'number', result: type("'done' | 'undone'").or({ failed: refusal }) })
  .or(type({ kind: "'response'", id: 'string' }).and(response))
  .or({ kind: "'open-url'", id: 'string', url: 'string' })
  .or({ kind: "'chunk'", id: 'string', data: 'string' })
  .or({ kind: "'your-turn'", threadId: 'string', from: person, subject: 'string' })
  .or({ kind: "'protocol-error'", reason: "'version-mismatch' | 'malformed'", detail: 'string' })

// The build fails here if the schema and the types in protocol.ts ever differ:
// a field one has and the other lacks, a value one allows and the other does not.
const coreSchemaMatches: Same<Flat<typeof coreMessage.infer>, Flat<Plain<CoreMessage>>> = true
void coreSchemaMatches

/** Checks one decoded JSON value from the core. Returns null when it is a valid core message, else what is wrong. */
export function coreMessageProblem(value: unknown): string | null {
  const parsed = coreMessage(value)
  return parsed instanceof type.errors ? parsed.summary : null
}
