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

export type Message = { id: MessageId, from: Person, to: Array<Person>, cc: Array<Person>, sentAt: string, unread: boolean, body: Body, 
/**
 * From the List-Unsubscribe header, or else a link in the body once it has loaded.
 */
unsubscribe: Unsubscribe | null, attachments: Array<Attachment>, 
/**
 * Set only on a message the user sent that the provider does not hold yet, or refused.
 */
delivery: Delivery | null, };

/**
 * Bodies download on demand, so one can be missing while offline. A body that has arrived
 * stays `loading` until the pipeline has run on it.
 *
 * `html` is still hostile input. The UI must render it sandboxed, with scripts off and the
 * network off in every state (`img-src data: cid:` and `base-uri 'none'`). It names no remote
 * image: shown images come from the core, through `Request::Image`.
 */
export type Body = { "state": "ready", 
/**
 * The plain text, as the message has it.
 */
text: string, 
/**
 * The HTML, the same in every state: trackers gone, each remote image a placeholder
 * (see `Images`), and no `<base>`.
 */
html: string | null, 
/**
 * True when the message has HTML the core would not pass on, so `html` is null: the
 * parser could not be sure how a browser would read it, or the check on the core's
 * own output found something its rules take out. The UI shows `text` instead, or says
 * the formatting could not be shown safely when `text` is blank.
 */
htmlWithheld: boolean, images: Images, 
/**
 * None when the body ends in no quote.
 */
quote: Quote | null, 
/**
 * The start of the new part, at most 200 characters with runs of space made one: from
 * the text before its quote, or from the HTML's text before its quote when the text is
 * blank. A folded message row shows it.
 */
preview: string, 
/**
 * How to color `html` in a dark reader. None when `html` is.
 */
colors: Colors | null, } | { "state": "loading" } | { "state": "unavailable", reason: Unavailable, };

export type Unavailable = "offline" | "too-large" | "gone";

/**
 * A message's remote images, and the trackers the core took out. It has blocked images when
 * `remote` is not empty and `shown` is `blocked`.
 */
export type Images = { 
/**
 * Whether the user shows them. Set with the `set-images` command.
 */
shown: ShowImages, 
/**
 * Every remote image URL left after trackers are taken out, once each, in the order the
 * HTML names them, at most 100. Empty means showing images changes nothing. In `html`,
 * each is a placeholder that names its index `i` here:
 *   - an `<img>` is `<span data-letterbox-image="i">alt</span>`, with its alt text, and
 *     `data-letterbox-width` and `data-letterbox-height` when it had a width or a height,
 *   - an image `<input>`, a `<video>`'s poster or an SVG `<image>` carries
 *     `data-letterbox-image="i"` and no longer names the URL,
 *   - an element whose `background` attribute named one carries `data-letterbox-background="i"`,
 *   - a CSS `url()` is `var(--letterbox-image-i, none)`.
 *
 * While `shown` is not `blocked`, the UI asks for each with `Request::Image` and puts the
 * bytes in as a `data:` URL.
 */
remote: Array<string>, 
/**
 * The trackers taken out, in the order the HTML named them. The core never fetches one.
 */
trackers: Array<Tracker>, };

/**
 * Whether a message's remote images are shown. The `set-images` command takes one of these
 * for a message, and the message then reports it. The choice is per message only: no provider
 * gives a sure sign of who sent a message (see crates/core/src/body/mod.rs), so none is
 * carried over to other mail from the same address.
 */
export type ShowImages = "blocked" | "message";

/**
 * One remote image the core took out as a tracker.
 */
export type Tracker = { 
/**
 * The host it would have loaded from, for example "list-manage.com".
 */
host: string, reason: TrackerReason, };

/**
 * Why the core judged an image a tracker. The rules are in crates/core/src/body/trackers.rs.
 */
export type TrackerReason = "known-host" | "tiny" | "hidden" | "beacon";

/**
 * The quoted history at the end of a body, so a UI can fold it. `text` and `html` are where it
 * starts, as offsets in UTF-16 code units, what JavaScript's `slice` counts: the new part is
 * `body.text.slice(0, quote.text)`, and the quote is the rest, with its enclosing markup. At
 * least one is set. The body itself stays whole.
 */
export type Quote = { 
/**
 * Into `text`. None when the text ends in no quote.
 */
text: number | null, 
/**
 * Into `html`. None when the HTML ends in no quote. The new part,
 * `body.html.slice(0, quote.html)`, is a prefix a browser closes by itself.
 */
html: number | null, 
/**
 * A hint that it only repeats what this conversation holds: true when the message replies
 * to messages (every Message-ID in its References) that are all in this conversation.
 */
inConversation: boolean, };

/**
 * How to unsubscribe from the list a message came from: the one way to use, chosen by the
 * core. The core only reads it: acting on it sends mail or a request to the sender, which
 * confirms the address is read.
 */
export type Unsubscribe = { "method": "one-click", url: string, 
/**
 * True once a DKIM signature that covers List-Unsubscribe and List-Unsubscribe-Post is
 * verified, as RFC 8058 requires before a POST. The core does not check that yet, so
 * it is always false.
 */
verified: boolean, } | { "method": "mailto", to: string, uri: string, } | { "method": "web", url: string, from: UnsubscribeSource, };

/**
 * Where a web unsubscribe target came from.
 */
export type UnsubscribeSource = "header" | "body";

/**
 * The bytes of one remote image, after its `chunk` messages, which carry them as base64.
 *
 * The UI binds them through DOM APIs only: it sets the placeholder element's `src` (or
 * `poster`, `href`) to a `data:` URL, or a `--letterbox-image-i` custom property on the
 * frame's root with `style.setProperty`. It never writes them into CSS text the sender wrote.
 */
export type ImageFile = { 
/**
 * Read from the bytes, never from the server's word: `image/png`, `image/jpeg`,
 * `image/gif`, `image/webp` or `image/avif`. SVG is refused.
 */
mime: string, size: number, };

/**
 * Why the core did not fetch an image.
 */
export type ImageError = "gone" | "blocked" | "refused" | "too-large" | "unreachable";

/**
 * How to color a message's HTML in a dark reader. The core replaced each color the HTML sets
 * with `var(--letterbox-color-N, <its own color>)`, where N is the color's index in `palette`:
 * in inline styles and `<style>` blocks, for text (`color`, `text-decoration`), backgrounds
 * (`background`, gradients too) and borders (`border*`, `outline`). A color longhand whose
 * value is not just colors the core reads stays as written, so a browser still drops an
 * invalid one. An element whose `bgcolor` (on body, table parts and cells), `<font color>`,
 * or `<body text>`, `link`, `vlink` or `alink` set one carries `data-letterbox-bg`, `-text`,
 * `-link`, `-vlink` or `-alink` naming its N. A `<style>` at the start of `html` applies it
 * from an anonymous cascade layer, so every rule of the sender's still wins where it did over
 * the attribute. A custom property the sender named `--letterbox-…` is renamed
 * `--sender-letterbox-…`, so only the UI sets these.
 *
 * With nothing set, the HTML shows the sender's own colors (`original`). For `dark`, the UI sets
 * each `--letterbox-color-N` to its swatch's `dark` on the frame's root, with
 * `style.setProperty`, as it does for images, and gives the frame its own dark defaults for what
 * the HTML leaves unset (the page, text and links). Those go in a cascade layer declared before
 * `html`, so they rank below every rule of the sender's and the core's.
 */
export type Colors = { 
/**
 * The user's choice for the message's sender. Set with the `set-colors` command.
 */
scheme: ColorScheme, look: HtmlLook, 
/**
 * Each color the HTML sets, once per role, in the order the HTML first sets it, at most 256.
 * Text set beside a background, in one rule or on one element, is a swatch of its own for
 * that background when its dark value differs there. Colors past 256 keep their own value in
 * both schemes.
 */
palette: Array<Swatch>, };

/**
 * How a UI colors a message's HTML. The choice is per sender: by the From address, in the
 * message's account. A sender's choice applies to all its mail, new mail too. Unlike showing
 * images, it changes only how the frame paints: nothing is fetched and the sender learns
 * nothing, so anyone who writes that address in a From gains nothing by it.
 */
export type ColorScheme = "dark" | "original";

/**
 * What kind of HTML a message has, so a UI knows whose type to set it in.
 */
export type HtmlLook = "branded" | "simple";

/**
 * One color the HTML sets, for one role.
 */
export type Swatch = { role: ColorRole, 
/**
 * The sender's color, as `#rrggbb`, or `#rrggbbaa` when it is not opaque.
 */
original: string, 
/**
 * Its value for the dark reader (crates/core/src/body/dark.rs), in the same form. The same
 * hue, with its lightness turned over against the reader's background where the original
 * was meant for a light page. Text keeps a contrast of at least 4.5:1 (WCAG AA), made more
 * opaque if it must be, on the dark value of the background set beside it, else on the
 * reader's background (#1b1b1e). A background keeps 4.5:1 under the reader's text
 * (#e4e4e4). A border has no floor.
 */
dark: string, };

/**
 * What a color paints.
 */
export type ColorRole = "text" | "background" | "border";

export type Attachment = { blobId: BlobId, name: string, mime: string, size: number, inline: boolean, };

export type ThreadFilter = { 
/**
 * Leave out to list every account together.
 */
accountId?: AccountId, mailboxId?: MailboxId, turn?: Turn, unread?: boolean, 
/**
 * Full-text search over the local index.
 */
text?: string, 
/**
 * True lists only conversations whose last message is 30 days old or more, false only the
 * newer ones. With `turn: mine` these are Let go? and Your turn. The core's clock decides,
 * so a conversation moves from one list to the other while the app runs. Leave out for both.
 */
retired?: boolean, 
/**
 * Only the conversations Updates groups under this sender (see `SenderSummary`).
 */
sender?: SenderId, };

/**
 * Every live view. Add a variant here and a matching one to `Update`.
 */
export type Query = { "view": "accounts" } | { "view": "sign-in-options" } | { "view": "mailboxes", accountId?: AccountId, } | { "view": "threads", filter: ThreadFilter, offset: number, limit: number, } | { "view": "thread", threadId: ThreadId, } | { "view": "senders", accountId?: AccountId, mailboxId?: MailboxId, 
/**
 * The user's IANA time zone, such as "America/Chicago": `days` are their days in it,
 * and move on at its midnight. Leave out, or name a zone the core does not know, for UTC.
 */
zone?: string, offset: number, limit: number, } | { "view": "recipients", accountId: AccountId, prefix: string, limit: number, } | { "view": "change", change: ChangeId, };

/**
 * The answer to a query. A threads update replaces the whole window.
 */
export type Update = { "view": "accounts", data: Array<Account>, } | { "view": "sign-in-options", data: Array<SignInOption>, } | { "view": "mailboxes", data: Array<Mailbox>, } | { "view": "threads", data: ThreadPage, } | { "view": "thread", data: ThreadDetail | null, } | { "view": "senders", data: SenderPage, } | { "view": "recipients", data: Array<Recipient>, } | { "view": "change", data: ChangeHolder, };

export type ThreadPage = { total: number, threads: Array<ThreadSummary>, };

/**
 * One per sender in Updates, in one account.
 */
export type SenderId = Id<'Sender'>;

/**
 * One row of Updates: every automated conversation from one sender, in one account. A
 * conversation is automated when its newest message from someone else is (see turns.rs in
 * the core). Its sender is that message's address, compared without case, so news@ and
 * no-reply@ of one company are two senders. To act on all of a sender's conversations, list
 * them with `sender` in a threads filter and send one command naming their ids.
 */
export type SenderSummary = { id: SenderId, accountId: AccountId, 
/**
 * The name and address the newest conversation's message came from.
 */
name: string | null, address: string, 
/**
 * How many conversations, how many messages are in them, and how many of those are unread.
 */
threads: number, messages: number, unread: number, 
/**
 * The newest conversation's subject, and when its last message came.
 */
subject: string, lastMessageAt: string, 
/**
 * The messages in its conversations sent on each of the last 14 days, oldest first, the
 * last entry today. Days are the user's, in the query's `zone`, on the core's clock, which
 * moves them on at the zone's midnight.
 */
days: Array<SenderDay>, 
/**
 * How to unsubscribe, from the message the row's name and address come from: its
 * List-Unsubscribe header, or else a link in its body if that has loaded.
 */
unsubscribe: Unsubscribe | null, };

/**
 * One day of a sender's mail in Updates: how many messages were sent that day, and how many
 * of them are unread.
 */
export type SenderDay = { messages: number, unread: number, };

/**
 * One window of Updates, newest sender first. `total` counts every sender in it,
 * `unread_senders` those with unread mail, and `unread` their unread messages.
 */
export type SenderPage = { total: number, unreadSenders: number, unread: number, senders: Array<SenderSummary>, };

/**
 * Someone a `recipients` view suggests for a recipient field on `account_id`: a person the
 * user wrote to, or who wrote to the user, in the mail the core holds. Mail from machines
 * (list or bulk headers, or the provider's bulk verdict) and mail in spam count for nothing.
 * No-reply addresses and the account's own are never suggested. `prefix` matches, without
 * case, the start of the address, of any word of a name, or of a whole name. An empty prefix
 * suggests nobody.
 *
 * People the user wrote to come first, then people who only wrote to the user. Within each
 * group, people with more and newer mail come first: each message with them counts twice as
 * much as one from 30 days before it. Then the one with the newest mail, then by address.
 *
 * `address` is as their newest mail wrote it, and `name` is the newest display name their
 * mail gave, if any. `last_at` is when the newest mail with them was sent, either way.
 */
export type Recipient = { name: string | null, address: string, lastAt: string, };

/**
 * The conversation holding the message that send `change` wrote, for a UI that has to find
 * it: the one a new message started, or the one the core merged it into. Live, so a merge
 * moves it. `thread_id` is null for a change that is not a send the core holds, and once the
 * message is gone, as after an undo. Once the provider holds the message it stays where it is.
 */
export type ChangeHolder = { threadId: ThreadId | null, };

/**
 * A user intent. Every command but set-images and set-colors acts on whole threads.
 * Only set-turn, set-images and set-colors work with read-only access, because they never leave the device.
 */
export type Command = { "kind": "set-turn", threadIds: Array<ThreadId>, turn: TurnChoice, } | { "kind": "set-flags", threadIds: Array<ThreadId>, unread?: boolean, flagged?: boolean, } | { "kind": "set-mailboxes", threadIds: Array<ThreadId>, add: Array<MailboxId>, remove: Array<MailboxId>, } | { "kind": "trash", threadIds: Array<ThreadId>, } | { "kind": "send", draft: Draft, } | { "kind": "set-images", messageId: MessageId, show: ShowImages, } | { "kind": "set-colors", messageId: MessageId, scheme: ColorScheme, } | { "kind": "undo", change: ChangeId, };

/**
 * The turn a set-turn command asks for: a fixed holder, or `auto` to hand it back to the rule.
 */
export type TurnChoice = "mine" | "theirs" | "none" | "auto";

/**
 * A message for the core to send. `to`, `cc` and `bcc` hold bare addresses, for example
 * "ana@example.com". The core writes From, Date, Message-ID, In-Reply-To and References.
 * A new conversation has neither `in_reply_to` nor `forward_of`, a reply has the first, and
 * a forward the second. A draft with both is refused `invalid`.
 */
export type Draft = { accountId: AccountId, to: Array<string>, cc: Array<string>, bcc: Array<string>, subject: string, text: string, 
/**
 * Required, but may be null. `Option::deserialize` stops serde from reading a missing field as null.
 */
html: string | null, 
/**
 * The message this answers. Required, but may be null for a new conversation.
 */
inReplyTo: MessageId | null, 
/**
 * The message this forwards. The core adds the original below `text` (and `html`) in the
 * usual "Forwarded message" form, and carries its attachments with their names and types,
 * so a UI sends only what the user wrote. Leave it out for anything but a forward. A forward
 * starts a conversation of its own: it does not answer the original, so it moves no turn
 * there. Refused `unknown-target` when the core has no such message, or its body is gone,
 * and `conflict` while its body has not loaded (it loads when its conversation is open).
 * A forward of a send of the user's that the provider does not hold yet waits, `sending`,
 * until it does. It fails `unknown-target` if that send fails, or if an attachment is gone
 * by the time it goes out.
 */
forwardOf?: MessageId, 
/**
 * The original's files a forward leaves out, each by the `blobId` the original's message
 * lists it under. Leave it out to carry every file. Refused `invalid` on a draft that
 * forwards nothing, or for a file the original does not carry.
 */
forwardWithout?: Array<BlobId>, };

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
export type Request = { "method": "sign-in", option: SignInOptionId, password?: PasswordInput, } | { "method": "sign-out", accountId: AccountId, deleteLocalMail: boolean, } | { "method": "sync-now", accountId?: AccountId, } | { "method": "blob", blobId: BlobId, } | { "method": "attachment", blobId: BlobId, } | { "method": "position", filter: ThreadFilter, threadId: ThreadId, } | { "method": "network-back" } | { "method": "image", messageId: MessageId, index: number, };

export type PasswordInput = { username: string, password: string, server?: string, };

/**
 * The answer to one request, by method.
 */
export type Response = { "method": "sign-in" } & Answer<SignedIn, SignInError> | { "method": "sign-out" } & Answer<Empty, Never> | { "method": "sync-now" } & Answer<Empty, SyncNowError> | { "method": "blob" } & Answer<BlobUrl, BlobError> | { "method": "attachment" } & Answer<AttachmentFile, AttachmentError> | { "method": "position" } & Answer<Position, Never> | { "method": "network-back" } & Answer<Empty, Never> | { "method": "image" } & Answer<ImageFile, ImageError>;

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

/**
 * The answer to `attachment`, after its bytes. `size` is how many bytes the chunks carried.
 */
export type AttachmentFile = { 
/**
 * The file name the message gives. Hostile input: a UI that makes a path from it cleans it first.
 */
name: string, mime: string, size: number, };

export type AttachmentError = "offline" | "gone" | "too-large";

/**
 * The answer to `position`: how many conversations sort before this one in the list its
 * filter gives right now, newest first, so its row is at that offset. Null when that list
 * does not hold it, as for a conversation that is gone or does not pass the filter.
 */
export type Position = { offset: number | null, };

export type ClientMessage = { "kind": "hello", protocol: number, } | { "kind": "subscribe", sub: SubscriptionId, query: Query, } | { "kind": "unsubscribe", sub: SubscriptionId, } | { "kind": "command", change: ChangeId, command: Command, } | { "kind": "request", id: RequestId, request: Request, };

export type CoreMessage = { "kind": "welcome", protocol: number, rev: number, } | { "kind": "update", sub: SubscriptionId, rev: number, } & ({ "view": "accounts", data: Array<Account>, } | { "view": "sign-in-options", data: Array<SignInOption>, } | { "view": "mailboxes", data: Array<Mailbox>, } | { "view": "threads", data: ThreadPage, } | { "view": "thread", data: ThreadDetail | null, } | { "view": "senders", data: SenderPage, } | { "view": "recipients", data: Array<Recipient>, } | { "view": "change", data: ChangeHolder, }) | { "kind": "accepted", change: ChangeId, rev: number, } | { "kind": "rejected", change: ChangeId, reason: Refusal, conflict?: UndoConflict, } | { "kind": "settled", change: ChangeId, rev: number, result: ChangeResult, } | { "kind": "response", id: RequestId, } & ({ "method": "sign-in" } & Answer<SignedIn, SignInError> | { "method": "sign-out" } & Answer<Empty, Never> | { "method": "sync-now" } & Answer<Empty, SyncNowError> | { "method": "blob" } & Answer<BlobUrl, BlobError> | { "method": "attachment" } & Answer<AttachmentFile, AttachmentError> | { "method": "position" } & Answer<Position, Never> | { "method": "network-back" } & Answer<Empty, Never> | { "method": "image" } & Answer<ImageFile, ImageError>) | { "kind": "open-url", id: RequestId, url: string, } | { "kind": "chunk", id: RequestId, data: string, } | { "kind": "your-turn" } & YourTurn | { "kind": "protocol-error", reason: ProtocolErrorReason, detail: string, };

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
