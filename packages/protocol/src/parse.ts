// Schemas for both directions of the protocol. The core checks every client
// message before it acts on it. The harness checks every core message, so a core
// in any language is held to the same shapes.
//
// The schemas are written by hand next to the types in protocol.ts. The type
// checks below fail the build if a schema and its type ever disagree.

import { type } from 'arktype'
import type { ClientMessage, CoreMessage } from './protocol.ts'

const turn = type("'mine' | 'theirs' | 'none'")

const filter = type({
  'accountId?': 'string',
  'mailboxId?': 'string',
  'turn?': turn,
  'unread?': 'boolean',
  'text?': 'string',
})

const query = type({ view: "'accounts'" })
  .or({ view: "'sign-in-options'" })
  .or({ view: "'mailboxes'", 'accountId?': 'string' })
  .or({ view: "'threads'", filter, offset: 'number.integer >= 0', limit: 'number.integer > 0' })
  .or({ view: "'thread'", threadId: 'string' })

const draft = type({
  accountId: 'string',
  to: 'string[]',
  cc: 'string[]',
  bcc: 'string[]',
  subject: 'string',
  text: 'string',
  html: 'string | null',
  inReplyTo: 'string | null',
})

const command = type({ kind: "'set-turn'", threadIds: 'string[]', turn: turn.or("'auto'") })
  .or({ kind: "'set-flags'", threadIds: 'string[]', 'unread?': 'boolean', 'flagged?': 'boolean' })
  .or({ kind: "'set-mailboxes'", threadIds: 'string[]', add: 'string[]', remove: 'string[]' })
  .or({ kind: "'trash'", threadIds: 'string[]' })
  .or({ kind: "'send'", draft })
  .or({ kind: "'undo'", change: 'string' })

const request = type({
  method: "'sign-in'",
  option: 'string',
  'password?': { username: 'string', password: 'string', 'server?': 'string' },
})
  .or({ method: "'sign-out'", accountId: 'string', deleteLocalMail: 'boolean' })
  .or({ method: "'sync-now'", 'accountId?': 'string' })
  .or({ method: "'blob'", blobId: 'string' })

const clientMessage = type({ kind: "'hello'", protocol: 'number' })
  .or({ kind: "'subscribe'", sub: 'string', query })
  .or({ kind: "'unsubscribe'", sub: 'string' })
  .or({ kind: "'command'", change: 'string', command })
  .or({ kind: "'request'", id: 'string', request })

type Parsed = typeof clientMessage.infer

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
  "'not-permitted' | 'not-supported' | 'unknown-target' | 'conflict' | 'refused-by-provider' | 'invalid'",
)

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

const body = type({ state: "'ready'", text: 'string', html: 'string | null', hasRemoteContent: 'boolean' })
  .or({ state: "'loading'" })
  .or({ state: "'unavailable'", reason: "'offline' | 'too-large' | 'gone'" })

const message = type({
  id: 'string',
  from: person,
  to: person.array(),
  cc: person.array(),
  sentAt: 'string',
  unread: 'boolean',
  body,
  attachments: type({ blobId: 'string', name: 'string', mime: 'string', size: 'number', inline: 'boolean' }).array(),
})

const update = type({ view: "'accounts'", data: account.array() })
  .or({
    view: "'sign-in-options'",
    data: type({ id: 'string', label: 'string', method: "'oauth' | 'password'" }).array(),
  })
  .or({ view: "'mailboxes'", data: mailbox.array() })
  .or({ view: "'threads'", data: { total: 'number', threads: type(summaryFields).array() } })
  .or({ view: "'thread'", data: type({ ...summaryFields, messages: message.array() }).or('null') })

const response = type({ method: "'sign-in'", ok: 'true', result: { accountId: 'string' } })
  .or({
    method: "'sign-in'",
    ok: 'false',
    error: "'cancelled' | 'denied' | 'timed-out' | 'superseded' | 'wrong-password' | 'offline'",
  })
  .or({ method: "'sign-out'", ok: 'true', result: { '[string]': 'never' } })
  .or({ method: "'sign-out'", ok: 'false', error: 'never' })
  .or({ method: "'sync-now'", ok: 'true', result: { '[string]': 'never' } })
  .or({ method: "'sync-now'", ok: 'false', error: "'offline'" })
  .or({ method: "'blob'", ok: 'true', result: { url: 'string', mime: 'string', size: 'number' } })
  .or({ method: "'blob'", ok: 'false', error: "'offline' | 'gone' | 'not-supported'" })

const coreMessage = type({ kind: "'welcome'", protocol: 'number', rev: 'number' })
  .or(type({ kind: "'update'", sub: 'string', rev: 'number' }).and(update))
  .or({ kind: "'accepted'", change: 'string', rev: 'number' })
  .or({ kind: "'rejected'", change: 'string', reason: refusal })
  .or({ kind: "'settled'", change: 'string', rev: 'number', result: type("'done' | 'undone'").or({ failed: refusal }) })
  .or(type({ kind: "'response'", id: 'string' }).and(response))
  .or({ kind: "'open-url'", id: 'string', url: 'string' })
  .or({ kind: "'protocol-error'", reason: "'version-mismatch' | 'malformed'", detail: 'string' })

// The build fails here if the schema and the types in protocol.ts ever differ:
// a field one has and the other lacks, a value one allows and the other does not.
const clientSchemaMatches: Same<Flat<Parsed>, Flat<Plain<ClientMessage>>> = true
const coreSchemaMatches: Same<Flat<typeof coreMessage.infer>, Flat<Plain<CoreMessage>>> = true
void clientSchemaMatches
void coreSchemaMatches

export type ParseResult = { ok: true; message: ClientMessage } | { ok: false; problem: string }

/** Turns one decoded JSON value into a client message, or says what is wrong with it. */
export function parseClientMessage(value: unknown): ParseResult {
  const parsed = clientMessage(value)
  if (parsed instanceof type.errors) return { ok: false, problem: parsed.summary }
  // The schema checked every field. Branded ids differ from plain strings only in type, so this is the one place they get the brand.
  return { ok: true, message: parsed as ClientMessage }
}

/** Checks one decoded JSON value from the core. Returns null when it is a valid core message, else what is wrong. */
export function coreMessageProblem(value: unknown): string | null {
  const parsed = coreMessage(value)
  return parsed instanceof type.errors ? parsed.summary : null
}
