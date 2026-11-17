// Generated from crates/protocol/src/lib.rs by `cargo xtask protocol-ts`. Do not edit.
// Change the Rust types and run that command. `pnpm check` fails while this file is stale.

declare const brand: unique symbol
/** An opaque string. A client passes on the ids it was sent and never builds or parses one. */
export type Id<Name extends string> = string & { readonly [brand]: Name }

export const PROTOCOL = 0

export type AccountId = Id<'Account'>;

export type MailboxId = Id<'Mailbox'>;

export type ThreadId = Id<'Thread'>;

export type MessageId = Id<'Message'>;

export type BlobId = Id<'Blob'>;

export type SignInOptionId = Id<'SignInOption'>;

/**
 * One per subscription.
 */
export type SubscriptionId = Id<'Subscription'>;

/**
 * One per command.
 */
export type ChangeId = Id<'Change'>;

/**
 * One per request.
 */
export type RequestId = Id<'Request'>;

export type Account = { id: AccountId, address: string, 
/**
 * Display only, for example "Gmail". UI logic reads `can`, never this.
 */
providerLabel: string, can: Capabilities, status: AccountStatus, };

/**
 * What this account allows. The UI enables and hides controls from these alone.
 */
export type Capabilities = { 
/**
 * False while access is read-only. Every command except set-turn is then rejected.
 */
modify: boolean, send: boolean, 
/**
 * True where one message can sit in several mailboxes (labels). False for plain folders.
 */
multipleMailboxes: boolean, };

/**
 * Sync state of one account. `last_synced_at` lets the UI say honestly how stale a view is.
 */
export type AccountStatus = { "state": "syncing", done: number, total: number | null, lastSyncedAt: string | null, } | { "state": "idle", lastSyncedAt: string, } | { "state": "offline", lastSyncedAt: string | null, } | { "state": "needs-sign-in" } | { "state": "error", reason: AccountErrorReason, lastSyncedAt: string | null, };

export type AccountErrorReason = "provider" | "storage";

/**
 * A folder or a label. A message belongs to a set of these.
 */
export type Mailbox = { id: MailboxId, accountId: AccountId, name: string, 
/**
 * A mailbox with no role is a user folder or label.
 */
role: Role | null, parentId: MailboxId | null, unread: number, total: number, };

export type Role = "inbox" | "sent" | "drafts" | "archive" | "trash" | "spam";

export type Person = { name: string | null, address: string, isMe: boolean, };

/**
 * Who owes the next message in a conversation.
 */
export type Turn = "mine" | "theirs" | "none";

/**
 * Why the core decided that. Shown to the user and saved with every correction.
 */
export type TurnReason = "they-wrote-last" | "i-wrote-last" | "automated" | "not-addressed-to-me" | "asks-nothing" | "set-by-user";

export type TurnState = { holder: Turn, reason: TurnReason, };

/**
 * One row in a list. The core builds threads itself, so every provider gets them.
 */
export type ThreadSummary = { id: ThreadId, accountId: AccountId, subject: string, people: Array<Person>, snippet: string, lastMessageAt: string, messageCount: number, unread: boolean, flagged: boolean, hasAttachments: boolean, mailboxIds: Array<MailboxId>, turn: TurnState, 
/**
 * True while a change to this thread has not settled.
 */
pending: boolean, };

export type ThreadDetail = { messages: Array<Message>, id: ThreadId, accountId: AccountId, subject: string, people: Array<Person>, snippet: string, lastMessageAt: string, messageCount: number, unread: boolean, flagged: boolean, hasAttachments: boolean, mailboxIds: Array<MailboxId>, turn: TurnState, 
/**
 * True while a change to this thread has not settled.
 */
pending: boolean, };

export type Message = { id: MessageId, from: Person, to: Array<Person>, cc: Array<Person>, sentAt: string, unread: boolean, body: Body, attachments: Array<Attachment>, 
/**
 * Set only on a message the user sent that the provider does not hold yet, or refused.
 */
delivery: Delivery | null, };

/**
 * Bodies download on demand, so one can be missing while offline.
 * `html` is hostile input. The UI must render it sandboxed, with scripts and
 * network off. The core never fetches remote content named in a message.
 */
export type Body = { "state": "ready", text: string, html: string | null, hasRemoteContent: boolean, } | { "state": "loading" } | { "state": "unavailable", reason: Unavailable, };

export type Unavailable = "offline" | "too-large" | "gone";

export type Attachment = { blobId: BlobId, name: string, mime: string, size: number, inline: boolean, };

export type ThreadFilter = { 
/**
 * Leave out to list every account together.
 */
accountId?: AccountId, mailboxId?: MailboxId, turn?: Turn, unread?: boolean, 
/**
 * Full-text search over the local index.
 */
text?: string, };

/**
 * Every live view. Add a variant here and a matching one to `Update`.
 */
export type Query = { "view": "accounts" } | { "view": "sign-in-options" } | { "view": "mailboxes", accountId?: AccountId, } | { "view": "threads", filter: ThreadFilter, offset: number, limit: number, } | { "view": "thread", threadId: ThreadId, };

/**
 * The answer to a query. A threads update replaces the whole window.
 */
export type Update = { "view": "accounts", data: Array<Account>, } | { "view": "sign-in-options", data: Array<SignInOption>, } | { "view": "mailboxes", data: Array<Mailbox>, } | { "view": "threads", data: ThreadPage, } | { "view": "thread", data: ThreadDetail | null, };

export type ThreadPage = { total: number, threads: Array<ThreadSummary>, };

/**
 * A user intent. Every command acts on whole threads.
 * Only set-turn works with read-only access, because it never leaves the device.
 */
export type Command = { "kind": "set-turn", threadIds: Array<ThreadId>, turn: TurnChoice, } | { "kind": "set-flags", threadIds: Array<ThreadId>, unread?: boolean, flagged?: boolean, } | { "kind": "set-mailboxes", threadIds: Array<ThreadId>, add: Array<MailboxId>, remove: Array<MailboxId>, } | { "kind": "trash", threadIds: Array<ThreadId>, } | { "kind": "send", draft: Draft, } | { "kind": "undo", change: ChangeId, };

/**
 * The turn a set-turn command asks for: a fixed holder, or `auto` to hand it back to the rule.
 */
export type TurnChoice = "mine" | "theirs" | "none" | "auto";

/**
 * A message for the core to send. `to`, `cc` and `bcc` hold bare addresses, for example
 * "ana@example.com". The core writes From, Date, Message-ID, In-Reply-To and References.
 */
export type Draft = { accountId: AccountId, to: Array<string>, cc: Array<string>, bcc: Array<string>, subject: string, text: string, 
/**
 * Required, but may be null. `Option::deserialize` stops serde from reading a missing field as null.
 */
html: string | null, 
/**
 * The message this answers. Required, but may be null for a new conversation.
 */
inReplyTo: MessageId | null, };

/**
 * How far a message the user sent has got. Messages the provider holds have none.
 */
export type Delivery = { "state": "held", change: ChangeId, until: string, } | { "state": "sending", change: ChangeId, } | { "state": "failed", change: ChangeId, reason: Refusal, };

/**
 * Why the core or the provider said no.
 */
export type Refusal = "not-permitted" | "not-supported" | "unknown-target" | "conflict" | "refused-by-provider" | "invalid" | "unconfirmed";

/**
 * The last word on a change: `"done"`, `"undone"` or `{"failed": refusal}` on the wire.
 */
export type ChangeResult = "done" | "undone" | { "failed": Refusal };

/**
 * Why an undo was refused `conflict`, when there is more to say. An undo trusts only what
 * the provider confirmed: the change's answers, or a sync after it.
 */
export type UndoConflict = { "kind": "changed", field: UndoField, } | { "kind": "partly-applied", field: UndoField, } | { "kind": "outcome-unknown" } | { "kind": "mailbox-gone", mailboxId: MailboxId, };

/**
 * One field a change set: a message's place in a mailbox, its read state or flag, or a
 * conversation's turn.
 */
export type UndoField = { "kind": "mailbox", messageId: MessageId, mailboxId: MailboxId, } | { "kind": "unread", messageId: MessageId, } | { "kind": "flagged", messageId: MessageId, } | { "kind": "turn", threadId: ThreadId, };

/**
 * A way to add an account. The UI lists these and never hard-codes a provider.
 */
export type SignInOption = { id: SignInOptionId, label: string, method: SignInMethod, };

export type SignInMethod = "oauth" | "password";

/**
 * Every one-shot call. Add a variant here and a matching one to `Response`.
 */
export type Request = { "method": "sign-in", option: SignInOptionId, password?: PasswordInput, } | { "method": "sign-out", accountId: AccountId, deleteLocalMail: boolean, } | { "method": "sync-now", accountId?: AccountId, } | { "method": "blob", blobId: BlobId, };

export type PasswordInput = { username: string, password: string, server?: string, };

/**
 * The answer to one request, by method.
 */
export type Response = { "method": "sign-in" } & Answer<SignedIn, SignInError> | { "method": "sign-out" } & Answer<Empty, Never> | { "method": "sync-now" } & Answer<Empty, SyncNowError> | { "method": "blob" } & Answer<BlobUrl, BlobError>;

/**
 * A result or an error. On the wire: `{"ok": true, "result": ...}` or `{"ok": false, "error": ...}`.
 * Build one from a `Result` with `Answer::from`.
 */
export type Answer<T, E> = { ok: True, result: T, } | { ok: False, error: E, };

/**
 * `true` on the wire, and `true` in TypeScript: the `ok` of a success.
 */
export type True = true;

/**
 * `false` on the wire, and `false` in TypeScript: the `ok` of a failure.
 */
export type False = false;

/**
 * A result with no fields: `{}`.
 */
export type Empty = Record<string, never>;

/**
 * An error that cannot happen.
 */
export type Never = never;

export type SignedIn = { accountId: AccountId, };

export type SignInError = "cancelled" | "denied" | "timed-out" | "superseded" | "wrong-password" | "offline" | "keychain";

export type SyncNowError = "offline";

export type BlobUrl = { url: string, mime: string, size: number, };

export type BlobError = "offline" | "gone" | "not-supported";

export type ClientMessage = { "kind": "hello", protocol: number, } | { "kind": "subscribe", sub: SubscriptionId, query: Query, } | { "kind": "unsubscribe", sub: SubscriptionId, } | { "kind": "command", change: ChangeId, command: Command, } | { "kind": "request", id: RequestId, request: Request, };

export type CoreMessage = { "kind": "welcome", protocol: number, rev: number, } | { "kind": "update", sub: SubscriptionId, rev: number, } & ({ "view": "accounts", data: Array<Account>, } | { "view": "sign-in-options", data: Array<SignInOption>, } | { "view": "mailboxes", data: Array<Mailbox>, } | { "view": "threads", data: ThreadPage, } | { "view": "thread", data: ThreadDetail | null, }) | { "kind": "accepted", change: ChangeId, rev: number, } | { "kind": "rejected", change: ChangeId, reason: Refusal, conflict?: UndoConflict, } | { "kind": "settled", change: ChangeId, rev: number, result: ChangeResult, } | { "kind": "response", id: RequestId, } & ({ "method": "sign-in" } & Answer<SignedIn, SignInError> | { "method": "sign-out" } & Answer<Empty, Never> | { "method": "sync-now" } & Answer<Empty, SyncNowError> | { "method": "blob" } & Answer<BlobUrl, BlobError>) | { "kind": "open-url", id: RequestId, url: string, } | { "kind": "your-turn" } & YourTurn | { "kind": "protocol-error", reason: ProtocolErrorReason, detail: string, };

/**
 * A sync brought a message from a person, in the inbox, that leaves this conversation the
 * user's turn: it is the newest message, and the turn rule gives the turn to the user because
 * its sender wrote last. Sent once per conversation per sync. Never for a message a snapshot
 * lists, which is how the first sync, a backfill and a resync bring mail, never for mail from
 * a machine, and never for the user's own sends. A UI that notifies shows `from` and `subject`
 * only, and opens `thread_id` when the notification is chosen.
 */
export type YourTurn = { threadId: ThreadId, from: Person, subject: string, };

export type ProtocolErrorReason = "version-mismatch" | "malformed";
