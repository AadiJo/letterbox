// The adapter contract: everything the core asks of one mail provider.
//
// The core's own definition is crates/core/src/adapter.rs. This TypeScript copy types
// what the sim server answers and the client the self-check drives. The scenarios run
// the Rust core against the sim server, so a shape that drifts between the two fails them.
//
// An adapter speaks one provider's protocol and reports that mailbox in the
// shapes below. It holds no mail and makes no decisions. The core owns the
// store, the threads, the turn rule and the queue of pending changes.
//
// Rules every adapter follows. The conformance scenarios in the harness check them.
//   1. Expected failures come back as values, never as thrown errors. Throw only for bugs.
//   2. `snapshot` takes its cursor before it lists the first page. A change made
//      while the core is paging then comes back from the next `changes` call.
//   3. `changes` may repeat something the core already has. The core applies
//      changes so that a repeat is harmless.
//   4. A ref names one message for as long as the provider keeps it in place.
//      A provider with plain folders may give a moved message a new ref. It then
//      reports the old ref as removed and the new one as added in the same result.
//   5. `apply` skips refs that no longer exist. It answers `unknown-target` only
//      when none of them exist.
//   6. `apply` sets values, so applying the same mutation twice is harmless
//      wherever the provider keeps refs stable.
//   7. No method reads or writes anything outside the provider. Adapters keep
//      their resume point in the cursor and their login in the session string.
//   8. `snapshot` answers `page-expired` when the provider no longer accepts the page
//      token. The core then lists the mailbox again from the first page.
//   9. Snapshot pages list the newest mail first, so the core can show recent mail
//      while it backfills the rest. Gmail's messages.list already does: "The returned
//      `messages` objects are listed in reverse chronological order (newest first)."
//      https://developers.google.com/workspace/gmail/api/guides/list-messages
//  10. `send` delivers the message as the core wrote it, to its To and Cc addresses and to
//      `bcc`, keeps a copy where the provider keeps sent mail, and answers with that copy's
//      ref. Later `changes` and snapshots report the copy under that ref. It answers
//      `offline` (or another failure) only when the message surely did not reach the
//      provider, such as when no connection was made, and `unconfirmed` when it may have.
//      A provider offers no way to send a message only once, so after `unconfirmed`, or a
//      core that stopped during the call, the core never calls `send` for it again. It calls
//      `find` with its Message-ID instead.

import type { Mailbox, Time } from '@letterbox/protocol'

declare const brand: unique symbol
/** An opaque string minted by an adapter. The core stores it and hands it back. */
type Ref<Name extends string> = string & { readonly [brand]: Name }

/** Names one message at the provider. See rule 4 for when it can change. */
export type MessageRef = Ref<'RemoteMessage'>
/** Names one folder or label at the provider. */
export type MailboxRef = Ref<'RemoteMailbox'>
/** Where the next `changes` call resumes. It can be large, for example a list of known ids. */
export type Cursor = Ref<'Cursor'>
/** Where the next `snapshot` call resumes. */
export type PageToken = Ref<'Page'>

/** The core turns these into the `can` field the UI reads. */
export type AdapterCapabilities = {
  /** False for read-only access. The core then never calls `apply` or `send`. */
  modify: boolean
  /** False when the provider cannot send. The core then never calls `send`. */
  send: boolean
  /** True where one message can sit in several mailboxes at once. */
  multipleMailboxes: boolean
}

export type RemoteMailbox = {
  ref: MailboxRef
  name: string
  role: Mailbox['role']
  parent: MailboxRef | null
}

export type RemoteAddress = { name: string | null; address: string }

/** The part of a message that other devices can change. */
export type RemoteState = {
  ref: MessageRef
  /** Exactly one entry when `multipleMailboxes` is false. */
  mailboxes: MailboxRef[]
  unread: boolean
  flagged: boolean
}

/** The part of a message that never changes after delivery. */
export type RemoteFacts = {
  /** The Message-ID header without angle brackets, or null if the message has none. */
  messageId: string | null
  /** Message-IDs from In-Reply-To and References, oldest first, without angle brackets. */
  references: string[]
  subject: string
  from: RemoteAddress
  to: RemoteAddress[]
  cc: RemoteAddress[]
  sentAt: Time
  /** The start of the plain text, at most 200 characters, with quoted replies left out. */
  preview: string
  /** Size in bytes as the provider reports it. */
  size: number
  hasAttachments: boolean
  /** Raw header facts the turn rule reads. Empty string when the header is absent. */
  headers: {
    listUnsubscribe: boolean
    listId: boolean
    precedence: string
    autoSubmitted: string
  }
  /** The provider's own verdict that this is bulk mail. Null when it gives none. */
  bulk: boolean | null
}

export type RemoteMessage = RemoteState & RemoteFacts

export type RemoteBody = {
  text: string
  /** Untrusted. The core passes it on unchanged and the UI sandboxes it. */
  html: string | null
  attachments: { name: string; mime: string; size: number; inline: boolean }[]
}

/**
 * Why a call could not reach or use the provider. The core retries the first three later.
 * `page-expired` comes from `snapshot` only. See rule 8.
 */
export type AdapterFailure = 'offline' | 'needs-sign-in' | 'provider-error' | 'page-expired'

/** The result of every adapter call: the value, or the reason the provider was not reached. */
export type Outcome<Value> = ({ ok: true } & Value) | { ok: false; failure: AdapterFailure }

export type SnapshotPage = {
  /** The full list of mailboxes, on every page. */
  mailboxes: RemoteMailbox[]
  messages: RemoteMessage[]
  next: PageToken | null
  /** Set on the last page only. See rule 2. */
  cursor: Cursor | null
}

export type ChangeSet = {
  /** Messages the core may not have yet, with all their facts. */
  added: RemoteMessage[]
  /** New state for messages the core already has. */
  updated: RemoteState[]
  removed: MessageRef[]
  /** The full list of mailboxes when the list changed, else null. */
  mailboxes: RemoteMailbox[] | null
  cursor: Cursor
}

export type ChangesResult =
  | ({ kind: 'changes' } & ChangeSet)
  /** The provider no longer remembers this cursor. The core runs `snapshot` again. */
  | { kind: 'cursor-expired' }

export type BodyResult = { kind: 'body'; body: RemoteBody } | { kind: 'gone' }

/** Which attachment an `attachment` call asks for: the one at `index` in the message's body. */
export type AttachmentCall = { ref: MessageRef; index: number }

/** An attachment's content in base64, or `gone` when the message or that attachment is. */
export type AttachmentResult = { kind: 'bytes'; base64: string } | { kind: 'gone' }

/** One change to push. Values are absolute: "set unread to false", never "toggle". */
export type Mutation =
  | { kind: 'flags'; refs: MessageRef[]; unread?: boolean; flagged?: boolean }
  /** With `multipleMailboxes` false, the core sends exactly one add and one remove: a move. */
  | { kind: 'mailboxes'; refs: MessageRef[]; add: MailboxRef[]; remove: MailboxRef[] }

export type ApplyResult =
  /** `moved` lists every ref the provider replaced. See rule 4. */
  | { kind: 'applied'; moved: { from: MessageRef; to: MessageRef }[] }
  | {
      kind: 'refused'
      /** `unknown-target` when no message it names exists, `unknown-mailbox` when a mailbox it names does not. */
      reason:
        | 'not-permitted'
        | 'not-supported'
        | 'unknown-target'
        | 'unknown-mailbox'
        | 'conflict'
        | 'refused-by-provider'
    }

/** One message for the provider to deliver, written whole by the core. */
export type Outgoing = {
  /** The RFC 5322 message every recipient gets, with CRLF line ends and no Bcc header. */
  raw: string
  /** Addresses that get the message without being named in it. */
  bcc: string[]
  /** Its Message-ID header, without angle brackets. */
  messageId: string
  /** The message it answers, for a provider that keeps threads of its own. */
  replyTo: MessageRef | null
}

export type SendResult =
  /** The provider holds its copy under `ref`. See rule 10. */
  | { kind: 'sent'; ref: MessageRef }
  | { kind: 'refused'; reason: Extract<ApplyResult, { kind: 'refused' }>['reason'] }
  /** The call may have reached the provider, but no answer came back. See rule 10. */
  | { kind: 'unconfirmed' }

/** What `find` found: the ref of the message with that Message-ID, or null. */
export type Found = { ref: MessageRef | null }

/** One signed-in mailbox at one provider. */
export interface Adapter {
  readonly capabilities: AdapterCapabilities
  /** Lists the whole mailbox in pages, newest first. Pass null for the first page. */
  snapshot(page: PageToken | null): Promise<Outcome<SnapshotPage>>
  /** Everything that changed since `cursor`, across all mailboxes. */
  changes(cursor: Cursor): Promise<Outcome<ChangesResult>>
  /** The body of one message, fetched when someone opens it. */
  body(ref: MessageRef): Promise<Outcome<BodyResult>>
  /** The content of one attachment, the one at `index` in what `body` lists. The core asks it when it forwards the message. */
  attachment(call: AttachmentCall): Promise<Outcome<AttachmentResult>>
  /** Pushes one change. The core calls this one at a time, in the order the user acted. */
  apply(mutation: Mutation): Promise<Outcome<ApplyResult>>
  /** Delivers one message (rule 10). The core calls it in the account's order, like `apply`. */
  send(message: Outgoing): Promise<Outcome<SendResult>>
  /** The message the provider holds with this Message-ID (without angle brackets), if any. */
  find(messageId: string): Promise<Outcome<Found>>
  /**
   * Ends every wait the adapter adds between tries of a call, such as a rate-limit backoff,
   * now and from now on. A call that was waiting answers `offline`. Calls in flight still
   * finish and later calls still reach the provider, so a closing core's work ends soon.
   */
  stopWaiting(): void
  /**
   * Stops waiting as `stopWaiting` does and releases sockets and timers. A call still in
   * flight may finish or answer `offline`. The adapter is not used again.
   */
  close(): Promise<void>
}

/** Why a sign-in attempt ended without an account. */
export type SignInFailure = 'cancelled' | 'denied' | 'timed-out' | 'wrong-password' | 'offline'

export type Connection = {
  address: string
  /** Shown next to the account. The only provider name the UI ever sees. */
  providerLabel: string
  adapter: Adapter
  /**
   * Whatever the adapter needs to reconnect after a restart. The core stores it
   * and hands it to `resume`. Real adapters put tokens here, so the core must
   * move this into the system keychain before any of them ships.
   */
  session: string
}

export type SignInInput = {
  password?: { username: string; password: string; server?: string }
  /** The adapter calls this with the page the user must visit. */
  openUrl: (url: string) => void
  /** Aborts when the user cancels or starts another attempt. The adapter then answers `cancelled`. */
  signal: AbortSignal
}

/** One way to add an account. The core lists every factory as a sign-in option. */
export interface AdapterFactory {
  readonly option: { id: string; label: string; method: 'oauth' | 'password' }
  /** Runs one sign-in attempt to its end. Always resolves. */
  connect(input: SignInInput): Promise<({ ok: true } & Connection) | { ok: false; failure: SignInFailure }>
  /** Rebuilds the adapter for an account that signed in before. */
  resume(session: string): Adapter
}
