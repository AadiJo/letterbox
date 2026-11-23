// How the fake Gmail server shows a labels mailbox in Gmail's JSON, and reads Gmail's
// ids back. Every translation is a pure function of the sim's store, so the fake keeps
// no state of its own about mail: the labels mailbox stays the one ground truth.
//
// The shapes follow https://developers.google.com/gmail/api/reference/rest/v1/users.messages
// and users.labels. Gmail ids look like the real ones: a message id is 16 hex digits, a
// user label is "Label_<n>", and system labels are named by their id ("INBOX").

import type { Cursor, MailboxRef, MessageRef, RemoteAddress, RemoteBody } from '../adapter.ts'
import type { Box, Store, Stored } from '../store.ts'

/** System labels every Gmail account has that are not folders: flags, importance and the inbox tabs. */
export const EXTRA_SYSTEM_LABELS = [
  'UNREAD',
  'STARRED',
  'IMPORTANT',
  'CHAT',
  'CATEGORY_PERSONAL',
  'CATEGORY_SOCIAL',
  'CATEGORY_PROMOTIONS',
  'CATEGORY_UPDATES',
  'CATEGORY_FORUMS',
] as const

/** The system label for a mailbox role. Gmail has no archive label, so an archive mailbox is a user label. */
const SYSTEM_BY_ROLE: Partial<Record<NonNullable<Box['role']>, string>> = {
  inbox: 'INBOX',
  sent: 'SENT',
  drafts: 'DRAFT',
  trash: 'TRASH',
  spam: 'SPAM',
}

export type GmailLabel = {
  id: string
  name: string
  type: 'system' | 'user'
  messageListVisibility?: 'show' | 'hide'
  labelListVisibility?: 'labelShow' | 'labelShowIfUnread' | 'labelHide'
}

/** The system label a sim mailbox stands for, if its role has one. */
const systemIdOf = (box: Box): string | undefined => (box.role === null ? undefined : SYSTEM_BY_ROLE[box.role])

/** The Gmail label id of a sim mailbox. */
export const labelIdOf = (box: Box): string => systemIdOf(box) ?? `Label_${box.ref.split('-')[1]}`

/** The sim mailbox a Gmail label id names, if any. */
export const boxOfLabel = (store: Store, id: string): Box | undefined =>
  [...store.boxes.values()].find((box) => labelIdOf(box) === id)

/** A user label's name: its path from the top, joined with "/", as Gmail shows nested labels. */
const pathOf = (store: Store, box: Box): string => {
  const parent = box.parent === null ? undefined : store.boxes.get(box.parent)
  return parent ? `${pathOf(store, parent)}/${box.name}` : box.name
}

/** users.labels.list: the mailboxes, then the system labels that are not mailboxes. */
export const labelsOf = (store: Store): GmailLabel[] => [
  ...[...store.boxes.values()].map((box): GmailLabel => {
    const system = systemIdOf(box)
    if (system !== undefined) return { id: system, name: system, type: 'system' }
    const id = labelIdOf(box)
    return {
      id,
      name: pathOf(store, box),
      type: 'user',
      messageListVisibility: 'show',
      labelListVisibility: 'labelShow',
    }
  }),
  ...EXTRA_SYSTEM_LABELS.map((id): GmailLabel => ({ id, name: id, type: 'system' })),
]

/** A message ref ("msg-12") as a Gmail id: 16 hex digits. */
export const gmailIdOf = (ref: MessageRef): string => `18c${Number(ref.split('-')[1]).toString(16).padStart(13, '0')}`

/** A message as list and history results name it: its id and its thread's. Each message is its own thread here. */
export const named = (ref: MessageRef) => ({ id: gmailIdOf(ref), threadId: gmailIdOf(ref) })

/** The message ref a Gmail id stands for, whether or not the message still exists. */
export const refOfId = (id: string): MessageRef | null => {
  const hex = /^18c([0-9a-f]{13})$/.exec(id)?.[1]
  return hex === undefined ? null : (`msg-${parseInt(hex, 16)}` as MessageRef)
}

/** The stored message a Gmail id names, if it still exists. */
export const messageOfId = (store: Store, id: string): Stored | undefined => {
  const ref = refOfId(id)
  return [...store.messages.values()].find((message) => message.ref === ref)
}

/**
 * A labels cursor ("log-<generation>-<position>") as a Gmail history id. Ids only grow:
 * cutting the log starts a new generation, a million ids further on.
 */
export const historyIdOf = (cursor: Cursor): string => {
  const [, generation, position] = /^log-(\d+)-(\d+)$/.exec(cursor) ?? []
  return String(Number(generation) * 1_000_000 + Number(position))
}

/** A Gmail history id back as a labels cursor. Null for one this fake never handed out. */
export const cursorOf = (historyId: string): Cursor | null => {
  if (!/^\d+$/.test(historyId)) return null
  const value = Number(historyId)
  return `log-${Math.floor(value / 1_000_000)}-${value % 1_000_000}` as Cursor
}

/** A message's label ids: its mailboxes, its flags, and the inbox tab its bulk verdict puts it in. */
export const labelIdsOf = (store: Store, message: Stored): string[] => {
  const boxes = message.mailboxes.flatMap((key) => {
    const box = store.boxes.get(key)
    return box ? [labelIdOf(box)] : []
  })
  const tab = message.facts.bulk === null ? [] : [message.facts.bulk ? 'CATEGORY_PROMOTIONS' : 'CATEGORY_PERSONAL']
  return [...boxes, ...(message.unread ? ['UNREAD'] : []), ...(message.flagged ? ['STARRED'] : []), ...tab]
}

/** The mailbox refs a list of label ids names, or null if one names no mailbox. */
export const mailboxRefsOf = (store: Store, ids: string[]): MailboxRef[] | null => {
  const refs = ids.map((id) => boxOfLabel(store, id)?.ref)
  return refs.every((ref) => ref !== undefined) ? refs : null
}

/** An address as a header shows it, quoting a name that needs it. */
const formatAddress = ({ name, address }: RemoteAddress): string => {
  if (name === null) return address
  const quoted = /[",;:<>@()[\]\\]/.test(name) ? `"${name.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"` : name
  return `${quoted} <${address}>`
}

/** The top-level Content-Type a body of this shape travels in. */
const contentTypeOf = (body: RemoteBody): string => {
  if (body.attachments.length > 0) return 'multipart/mixed; boundary="mixed"'
  return body.html === null ? 'text/plain; charset="UTF-8"' : 'multipart/alternative; boundary="alternative"'
}

type Header = { name: string; value: string }

/** The message's headers, rebuilt from its facts. */
export const headersOf = (message: Stored): Header[] => {
  const { facts } = message
  const references = facts.references.map((id) => `<${id}>`)
  const list: [string, string | null][] = [
    ['From', formatAddress(facts.from)],
    ['To', facts.to.map(formatAddress).join(', ')],
    ['Cc', facts.cc.length > 0 ? facts.cc.map(formatAddress).join(', ') : null],
    ['Subject', facts.subject],
    ['Date', new Date(facts.sentAt).toUTCString()],
    ['Message-ID', facts.messageId === null ? null : `<${facts.messageId}>`],
    ['In-Reply-To', references.at(-1) ?? null],
    ['References', references.length > 0 ? references.join(' ') : null],
    ['List-Unsubscribe', facts.headers.listUnsubscribeValue ?? null],
    ['List-Unsubscribe-Post', facts.headers.listUnsubscribePost ?? null],
    ['List-Id', facts.headers.listId ? '<news.list.example>' : null],
    ['Precedence', facts.headers.precedence || null],
    ['Auto-Submitted', facts.headers.autoSubmitted || null],
    ['MIME-Version', '1.0'],
    ['Content-Type', contentTypeOf(message.body)],
  ]
  return list.flatMap(([name, value]) => (value === null ? [] : [{ name, value }]))
}

/** Gmail's snippet: the start of the text, spaces collapsed, HTML-escaped. Quoted lines stay in. */
const snippetOf = (text: string): string =>
  text
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')

/** users.messages.get with format=minimal: id and labels. */
export const minimalOf = (store: Store, message: Stored, historyId: string) => ({
  id: gmailIdOf(message.ref),
  threadId: gmailIdOf(message.ref),
  labelIds: labelIdsOf(store, message),
  historyId,
})

/** users.messages.get with format=metadata: headers too, only those asked for when `only` is given. */
export const metadataOf = (store: Store, message: Stored, historyId: string, only: string[]) => {
  const wanted = new Set(only.map((name) => name.toLowerCase()))
  const headers = headersOf(message).filter((header) => wanted.size === 0 || wanted.has(header.name.toLowerCase()))
  return {
    ...minimalOf(store, message, historyId),
    snippet: snippetOf(message.body.text),
    internalDate: String(Date.parse(message.facts.sentAt)),
    sizeEstimate: message.facts.size,
    payload: { mimeType: contentTypeOf(message.body).split(';')[0], filename: '', headers, body: { size: 0 } },
  }
}

/** One MIME part with its content inline as base64url. */
const textPart = (mimeType: string, text: string) => ({
  mimeType,
  filename: '',
  headers: [{ name: 'Content-Type', value: `${mimeType}; charset="UTF-8"` }],
  body: { size: Buffer.byteLength(text), data: Buffer.from(text).toString('base64url') },
})

/** users.messages.get with format=full: the metadata plus the parsed MIME tree of `body`. */
export const fullOf = (store: Store, message: Stored, historyId: string, body: RemoteBody) => {
  const text = textPart('text/plain', body.text)
  const content =
    body.html === null
      ? text
      : {
          mimeType: 'multipart/alternative',
          filename: '',
          headers: [],
          body: { size: 0 },
          parts: [text, textPart('text/html', body.html)],
        }
  const attachments = body.attachments.map((attachment, index) => ({
    mimeType: attachment.mime,
    filename: attachment.name,
    headers: [
      { name: 'Content-Type', value: `${attachment.mime}; name="${attachment.name}"` },
      {
        name: 'Content-Disposition',
        value: `${attachment.inline ? 'inline' : 'attachment'}; filename="${attachment.name}"`,
      },
    ],
    body: { size: attachment.size, attachmentId: `attachment-${index + 1}` },
  }))
  const top =
    attachments.length === 0
      ? content
      : { mimeType: 'multipart/mixed', filename: '', headers: [], body: { size: 0 }, parts: [content, ...attachments] }
  const metadata = metadataOf(store, message, historyId, [])
  return { ...metadata, payload: { ...top, headers: metadata.payload.headers } }
}
