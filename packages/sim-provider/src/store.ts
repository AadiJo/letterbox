// The ground truth for one mailbox, and the parts both dialects share.
//
// mailbox.ts owns a Store and changes it. A dialect engine (labels.ts or
// folders.ts) decides what the dialects disagree on: how a message gets its
// ref, what a cursor holds, and how `changes` is worked out.

import type {
  ChangesResult,
  Cursor,
  MailboxRef,
  MessageRef,
  RemoteAddress,
  RemoteBody,
  RemoteFacts,
  RemoteMailbox,
  RemoteMessage,
  RemoteState,
} from './adapter.ts'
import type { Mailbox } from '@letterbox/protocol'
import type { SeedAddress, SeedAttachment, SeedMessage } from './contract.ts'

/** One folder or label. The last three fields are used by the folders dialect only. */
export type Box = {
  key: string
  ref: MailboxRef
  name: string
  role: Mailbox['role']
  /** Key of the parent mailbox. */
  parent: string | null
  /** Rises when the mailbox is reset. Part of every message ref in it. */
  epoch: number
  /** The number the next message filed here gets. Numbers are never reused within an epoch. */
  nextNumber: number
  /** Rises on every flag change in this mailbox. */
  counter: number
}

/** One message that exists. The last two fields are used by the folders dialect only. */
export type Stored = {
  key: string
  /** Delivery count. Snapshot pages and every list of messages follow it. */
  order: number
  facts: RemoteFacts
  body: RemoteBody
  unread: boolean
  flagged: boolean
  /** Mailbox keys. */
  mailboxes: string[]
  ref: MessageRef
  /** The message's number within its mailbox. */
  number: number
  /** The value of its mailbox's counter when its flags last changed. */
  changed: number
}

/** A delivered message before its dialect gives it a ref. */
export type Draft = Omit<Stored, 'ref' | 'number' | 'changed'>

export type Store = {
  /** By key, in creation order. */
  boxes: Map<string, Box>
  /** By key, in delivery order. Expunged messages are deleted. */
  messages: Map<string, Stored>
}

/** What one dialect decides. mailbox.ts calls these after it has checked keys and changed the store. */
export type Engine = {
  /** Gives a new message its ref. The caller adds the result to the store. */
  deliver(draft: Draft): Stored
  /** Puts an existing message in `mailboxes` instead of where it is. Returns the ref pair if its ref changed. */
  refile(message: Stored, mailboxes: string[]): { from: MessageRef; to: MessageRef } | null
  /** Records that the message's flags changed. */
  flagsChanged(message: Stored): void
  /** Records that the message is gone. The caller deletes it from the store. */
  expunged(message: Stored): void
  /** Records that a mailbox was added to the store. */
  mailboxCreated(): void
  /** Makes every cursor handed out so far stop working. */
  expire(): void
  /** The cursor for the store as it is now. */
  cursor(): Cursor
  changes(cursor: Cursor): ChangesResult
}

/** Looks up a mailbox by key. An unknown key is a scenario bug. */
export const boxOf = (store: Store, key: string): Box => {
  const box = store.boxes.get(key)
  if (!box) throw new Error(`sim provider: no mailbox with key "${key}"`)
  return box
}

/** The mailbox list as the adapter reports it. */
export const remoteMailboxes = (store: Store): RemoteMailbox[] =>
  [...store.boxes.values()].map((box) => ({
    ref: box.ref,
    name: box.name,
    role: box.role,
    parent: box.parent === null ? null : boxOf(store, box.parent).ref,
  }))

/** The changeable part of a message as the adapter reports it. */
export const stateOf = (store: Store, message: Stored): RemoteState => ({
  ref: message.ref,
  mailboxes: message.mailboxes.map((key) => boxOf(store, key).ref),
  unread: message.unread,
  flagged: message.flagged,
})

/** A message with all its facts, for snapshot pages and `added`. */
export const remoteMessage = (store: Store, message: Stored): RemoteMessage => ({
  ...stateOf(store, message),
  ...message.facts,
})

/** Turns a seed address into the adapter's shape. */
const addressOf = (seed: SeedAddress): RemoteAddress =>
  typeof seed === 'string' ? { name: null, address: seed } : { name: seed.name, address: seed.address }

/** Drops the angle brackets a scenario may have put around a Message-ID. */
export const bareMessageId = (seed: SeedMessage): string =>
  (seed.messageId ?? `${seed.key}@sim.test`).replace(/^<(.*)>$/, '$1')

/** The start of the text as a list row shows it: no quoted lines, single spaces, at most 200 characters. */
export const previewOf = (text: string): string =>
  text
    .split('\n')
    .filter((line) => !line.startsWith('>'))
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)

/** The facts a seed message reports. `references` and `bulk` come from the caller, which knows the dialect. */
export const factsOf = (seed: SeedMessage, references: string[], bulk: boolean | null): RemoteFacts => ({
  messageId: bareMessageId(seed),
  references,
  subject: seed.subject,
  from: addressOf(seed.from),
  to: seed.to.map(addressOf),
  cc: (seed.cc ?? []).map(addressOf),
  sentAt: seed.sentAt,
  preview: previewOf(seed.text),
  size: Buffer.byteLength(seed.text) + Buffer.byteLength(seed.html ?? ''),
  hasAttachments: attachmentsOf(seed).length > 0,
  headers: {
    listUnsubscribe: seed.headers?.listUnsubscribe ?? false,
    listId: seed.headers?.listId ?? false,
    precedence: seed.headers?.precedence ?? '',
    autoSubmitted: seed.headers?.autoSubmitted ?? '',
  },
  bulk,
})

/** The body a seed message returns when someone opens it. */
export const bodyOf = (seed: SeedMessage): RemoteBody => ({
  text: seed.text,
  html: seed.html ?? null,
  attachments: attachmentsOf(seed).map(({ name, mime, size }) => ({ name, mime, size, inline: false })),
})

/** A seed message's attachments: as it names them, or that many placeholder files. */
const attachmentsOf = ({ attachments = 0 }: SeedMessage): readonly SeedAttachment[] =>
  typeof attachments === 'number'
    ? Array.from({ length: attachments }, (_, index) => ({
        name: `file-${index + 1}.bin`,
        mime: 'application/octet-stream',
        size: 1000,
      }))
    : attachments
