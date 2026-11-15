// The protocol between the core and every UI. Version 0.
//
// One headless core process owns the store, the sync engine and the provider
// adapters. Every UI (a web shell, GPUI, a CLI for tests and agents) is a
// client that speaks only this protocol. Messages are JSON. The transport is
// not decided here: a local socket, stdio or in-process calls all work.
//
// Three kinds of traffic:
//   subscribe  the UI asks for a live view and gets an update each time it changes
//   command    the UI states a user intent. The core applies it locally first, then syncs it
//   request    a one-shot call with exactly one answer, such as sign-in
//
// Guarantees the core makes. Each one is a conformance test for any core or adapter.
//   1. Read your writes. An update with rev >= the rev of an accepted change includes that change.
//   2. Every accepted change gets exactly one `settled`.
//   3. Changes on one account reach the provider in the order they were accepted.
//   4. Sending the same ChangeId twice has the same effect as sending it once.
//   5. A failed change is reverted in the store before `settled` is sent.
//   6. No provider id, provider name or credential appears in a core-to-UI message.
//      The only exception is the display label on Account and SignInOption.
//   7. Every request gets exactly one response. That includes a sign-in that is
//      cancelled, superseded or timed out.
//   8. Updates caused by a command or request are sent before its `settled` or
//      `response`. A client that has the answer has already seen the effects.

export const PROTOCOL = 0

// ---------------------------------------------------------------- ids

declare const brand: unique symbol
/** An opaque string. Clients never build or parse one. Provider ids stay inside the core. */
type Id<Name extends string> = string & { readonly [brand]: Name }

// Minted by the core.
export type AccountId = Id<'Account'>
export type MailboxId = Id<'Mailbox'>
export type ThreadId = Id<'Thread'>
export type MessageId = Id<'Message'>
export type BlobId = Id<'Blob'>
export type SignInOptionId = Id<'SignInOption'>

// Minted by the client, one per subscription, command or request.
export type SubscriptionId = Id<'Subscription'>
export type ChangeId = Id<'Change'>
export type RequestId = Id<'Request'>

/** Store revision. It rises on every change to the store and never repeats. */
export type Rev = number
/** ISO 8601 in UTC, for example "2026-11-14T23:04:01Z". */
export type Time = string

type None = Record<never, never>
/** A result with no fields. Unlike `None`, it rejects any field at all. */
type Empty = Record<string, never>

// ---------------------------------------------------------------- model

export type Account = {
  id: AccountId
  address: string
  /** Display only, for example "Gmail". UI logic reads `can`, never this. */
  providerLabel: string
  can: Capabilities
  status: AccountStatus
}

/** What this account allows. The UI enables and hides controls from these alone. */
export type Capabilities = {
  /** False while access is read-only. Every command except set-turn is then rejected. */
  modify: boolean
  send: boolean
  /** True where one message can sit in several mailboxes (labels). False for plain folders. */
  multipleMailboxes: boolean
}

/** Sync state of one account. `lastSyncedAt` lets the UI say honestly how stale a view is. */
export type AccountStatus =
  | { state: 'syncing'; done: number; total: number | null; lastSyncedAt: Time | null }
  | { state: 'idle'; lastSyncedAt: Time }
  | { state: 'offline'; lastSyncedAt: Time | null }
  | { state: 'needs-sign-in' }
  | { state: 'error'; reason: 'provider' | 'storage'; lastSyncedAt: Time | null }

/** A folder or a label. A message belongs to a set of these. */
export type Mailbox = {
  id: MailboxId
  accountId: AccountId
  name: string
  /** A mailbox with no role is a user folder or label. */
  role: 'inbox' | 'sent' | 'drafts' | 'archive' | 'trash' | 'spam' | null
  parentId: MailboxId | null
  unread: number
  total: number
}

export type Person = { name: string | null; address: string; isMe: boolean }

/** Who owes the next message in a conversation. */
export type Turn = 'mine' | 'theirs' | 'none'

/** Why the core decided that. Shown to the user and saved with every correction. */
export type TurnReason =
  | 'they-wrote-last'
  | 'i-wrote-last'
  | 'automated'
  | 'not-addressed-to-me'
  | 'asks-nothing'
  | 'set-by-user'

/** One row in a list. The core builds threads itself, so every provider gets them. */
export type ThreadSummary = {
  id: ThreadId
  accountId: AccountId
  subject: string
  people: Person[]
  snippet: string
  lastMessageAt: Time
  messageCount: number
  unread: boolean
  flagged: boolean
  hasAttachments: boolean
  mailboxIds: MailboxId[]
  turn: { holder: Turn; reason: TurnReason }
  /** True while a change to this thread has not settled. */
  pending: boolean
}

export type ThreadDetail = ThreadSummary & { messages: Message[] }

export type Message = {
  id: MessageId
  from: Person
  to: Person[]
  cc: Person[]
  sentAt: Time
  unread: boolean
  body: Body
  attachments: Attachment[]
}

/**
 * Bodies download on demand, so one can be missing while offline.
 * `html` is hostile input. The UI must render it sandboxed, with scripts and
 * network off. The core never fetches remote content named in a message.
 */
export type Body =
  | { state: 'ready'; text: string; html: string | null; hasRemoteContent: boolean }
  | { state: 'loading' }
  | { state: 'unavailable'; reason: 'offline' | 'too-large' | 'gone' }

export type Attachment = { blobId: BlobId; name: string; mime: string; size: number; inline: boolean }

// ---------------------------------------------------------------- subscribe

export type ThreadFilter = {
  /** Leave out to list every account together. */
  accountId?: AccountId
  mailboxId?: MailboxId
  turn?: Turn
  unread?: boolean
  /** Full-text search over the local index. */
  text?: string
}

/**
 * Every live view. Add an entry here and Query and Update pick it up.
 * A threads update replaces the whole window.
 */
export interface Queries {
  accounts: { params: None; result: Account[] }
  'sign-in-options': { params: None; result: SignInOption[] }
  mailboxes: { params: { accountId?: AccountId }; result: Mailbox[] }
  threads: {
    params: { filter: ThreadFilter; offset: number; limit: number }
    result: { total: number; threads: ThreadSummary[] }
  }
  /** `null` once the thread no longer exists. */
  thread: { params: { threadId: ThreadId }; result: ThreadDetail | null }
}

export type Query = { [K in keyof Queries]: { view: K } & Queries[K]['params'] }[keyof Queries]
export type Update = { [K in keyof Queries]: { view: K; data: Queries[K]['result'] } }[keyof Queries]

// ---------------------------------------------------------------- command

/**
 * A user intent. Every command acts on whole threads.
 * Only set-turn works with read-only access, because it never leaves the device.
 */
export type Command =
  /** Correct the rule, or hand the thread back to it with 'auto'. */
  | { kind: 'set-turn'; threadIds: ThreadId[]; turn: Turn | 'auto' }
  | { kind: 'set-flags'; threadIds: ThreadId[]; unread?: boolean; flagged?: boolean }
  /** Archive is `remove: [inbox]`. A move is one add and one remove. */
  | { kind: 'set-mailboxes'; threadIds: ThreadId[]; add: MailboxId[]; remove: MailboxId[] }
  | { kind: 'trash'; threadIds: ThreadId[] }
  | { kind: 'send'; draft: Draft }
  /** Cancels a change that has not synced, or applies its opposite if it has. */
  | { kind: 'undo'; change: ChangeId }

export type Draft = {
  accountId: AccountId
  to: string[]
  cc: string[]
  bcc: string[]
  subject: string
  text: string
  html: string | null
  /** The core writes Message-ID, In-Reply-To and References from this. */
  inReplyTo: MessageId | null
}

/** Why the core or the provider said no. */
export type Refusal =
  | 'not-permitted'
  | 'not-supported'
  | 'unknown-target'
  | 'conflict'
  | 'refused-by-provider'
  | 'invalid'

// ---------------------------------------------------------------- request

/** A way to add an account. The UI lists these and never hard-codes a provider. */
export type SignInOption = { id: SignInOptionId; label: string; method: 'oauth' | 'password' }

/** Every one-shot call. Add an entry here and Request and Response pick it up. */
export interface Requests {
  /** Answers once the account exists. For oauth the core sends `open-url` first. */
  'sign-in': {
    params: { option: SignInOptionId; password?: { username: string; password: string; server?: string } }
    result: { accountId: AccountId }
    error: 'cancelled' | 'denied' | 'timed-out' | 'superseded' | 'wrong-password' | 'offline'
  }
  'sign-out': { params: { accountId: AccountId; deleteLocalMail: boolean }; result: Empty; error: never }
  'sync-now': { params: { accountId?: AccountId }; result: Empty; error: 'offline' }
  /** A local URL the core serves for one attachment or inline image. */
  blob: {
    params: { blobId: BlobId }
    result: { url: string; mime: string; size: number }
    error: 'offline' | 'gone' | 'not-supported'
  }
}

export type Request = { [K in keyof Requests]: { method: K } & Requests[K]['params'] }[keyof Requests]
export type Response = {
  [K in keyof Requests]: { method: K } & (
    | { ok: true; result: Requests[K]['result'] }
    | { ok: false; error: Requests[K]['error'] }
  )
}[keyof Requests]

// ---------------------------------------------------------------- envelope

export type ClientMessage =
  | { kind: 'hello'; protocol: number }
  | { kind: 'subscribe'; sub: SubscriptionId; query: Query }
  | { kind: 'unsubscribe'; sub: SubscriptionId }
  | { kind: 'command'; change: ChangeId; command: Command }
  | { kind: 'request'; id: RequestId; request: Request }

export type CoreMessage =
  | { kind: 'welcome'; protocol: number; rev: Rev }
  | ({ kind: 'update'; sub: SubscriptionId; rev: Rev } & Update)
  /** The change is in the store and in the durable queue. */
  | { kind: 'accepted'; change: ChangeId; rev: Rev }
  /** The change was never applied. */
  | { kind: 'rejected'; change: ChangeId; reason: Refusal }
  /** The last word on a change. A failed change is already reverted at `rev`. */
  | { kind: 'settled'; change: ChangeId; rev: Rev; result: 'done' | 'undone' | { failed: Refusal } }
  | ({ kind: 'response'; id: RequestId } & Response)
  /** The UI opens this in the system browser. The token goes to the core, never the UI. */
  | { kind: 'open-url'; id: RequestId; url: string }
  /** The core could not read a client message, or the versions differ. `detail` is for logs. */
  | { kind: 'protocol-error'; reason: 'version-mismatch' | 'malformed'; detail: string }
