// What the renderer keeps across a reload, in session storage: the sends sending.ts follows,
// the compose page's draft, and each conversation's reply draft (drafts.ts). Here are their
// rows, how a row is checked when read, and the read and the write. Storage may be missing or
// refuse, and then nothing is kept. sending.ts and drafts.ts decide what the rows hold and what
// each phase means.

import type { ChangeId, ThreadId } from '@letterbox/protocol'
import type { Reply } from './drafts.ts'

const KEY = 'letterbox.sends'
const PAGE_KEY = 'letterbox.page'
const REPLIES_KEY = 'letterbox.replies'

/**
 * One send in storage, by the phase it was in. Each phase is one way sending.ts follows or
 * keeps it. `threadId` is the conversation that holds it, or null for a new conversation the
 * core has not shown yet.
 */
export type Stored = { change: ChangeId; threadId: ThreadId | null; reply: Reply } & (
  | { phase: 'unknown' | 'followed' | 'undone' }
  | { phase: 'undoing'; undo: ChangeId }
)

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null
const isRecipients = (value: unknown) =>
  Array.isArray(value) &&
  value.every(
    (person) =>
      isObject(person) &&
      typeof person.address === 'string' &&
      (person.name === null || typeof person.name === 'string'),
  )

const isForwarding = (value: unknown) =>
  isObject(value) &&
  typeof value.of === 'string' &&
  typeof value.threadId === 'string' &&
  typeof value.subject === 'string' &&
  Array.isArray(value.without) &&
  value.without.every((blob) => typeof blob === 'string')

/**
 * A reply as drafts.ts holds it. One kept before forwards and new messages has no `forward`,
 * and reads as a reply (`withDefaults`).
 */
function isReply(reply: unknown): reply is Reply {
  return (
    isObject(reply) &&
    ['accountId', 'subject', 'text'].every((key) => typeof reply[key] === 'string') &&
    (reply.inReplyTo === null || typeof reply.inReplyTo === 'string') &&
    (reply.forward === undefined || reply.forward === null || isForwarding(reply.forward)) &&
    isRecipients(reply.to) &&
    isRecipients(reply.cc) &&
    isRecipients(reply.bcc) &&
    isObject(reply.typing) &&
    typeof reply.bccLost === 'boolean'
  )
}

/** `reply` with the fields a row from before they existed leaves out. */
const withDefaults = (reply: Reply): Reply => ({ ...reply, forward: reply.forward ?? null })

/** A stored send, as `saveStored` wrote it. Anything else in storage is ignored. */
function isStored(value: unknown): value is Stored {
  if (!isObject(value) || typeof value.change !== 'string') return false
  if (value.threadId !== null && typeof value.threadId !== 'string') return false
  const { phase } = value
  const known =
    phase === 'unknown' ||
    phase === 'followed' ||
    phase === 'undone' ||
    (phase === 'undoing' && typeof value.undo === 'string')
  // A row may name no conversation only for a new message or a forward, which answers nothing.
  return known && isReply(value.reply) && (value.threadId !== null || value.reply.inReplyTo === null)
}

/** The rows the last load saved, at boot. Empty when storage is missing, refuses, or holds nothing of ours. */
export function readStored(): Stored[] {
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(KEY) ?? '[]')
    // Freshly parsed, so each row can take its defaults in place.
    return Array.isArray(parsed)
      ? parsed.filter(isStored).map((row) => Object.assign(row, { reply: withDefaults(row.reply) }))
      : []
  } catch {
    return []
  }
}

/** Replaces the stored rows with `rows`. */
export function saveStored(rows: readonly Stored[]) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(rows))
  } catch {
    // Without storage, a reload finds held replies only as the reader shows them.
  }
}

/** The compose page's draft, and whether the page was up. */
export type StoredPage = { reply: Reply; open: boolean }

/** The page's draft the last load kept, or null. */
export function readStoredPage(): StoredPage | null {
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(PAGE_KEY) ?? 'null')
    if (!isObject(parsed) || typeof parsed.open !== 'boolean' || !isReply(parsed.reply)) return null
    // The page holds new messages and forwards only.
    return parsed.reply.inReplyTo === null ? { reply: withDefaults(parsed.reply), open: parsed.open } : null
  } catch {
    return null
  }
}

/** Keeps `page` for the next load, or nothing. */
export function saveStoredPage(page: StoredPage | null) {
  try {
    if (page) sessionStorage.setItem(PAGE_KEY, JSON.stringify(page))
    else sessionStorage.removeItem(PAGE_KEY)
  } catch {
    // Without storage, a reload starts the page empty.
  }
}

/** A conversation's reply draft the user can still edit, and whether its editor was open or folded. */
export type StoredReply = { threadId: ThreadId; reply: Reply; state: 'open' | 'collapsed' }

/** A stored reply draft, as `saveStoredReplies` wrote it: a reply, never a new message or a forward. */
const isStoredReply = (value: unknown): value is StoredReply =>
  isObject(value) &&
  typeof value.threadId === 'string' &&
  (value.state === 'open' || value.state === 'collapsed') &&
  isReply(value.reply) &&
  value.reply.inReplyTo !== null

/** The reply drafts the last load kept. Empty when storage is missing, refuses, or holds nothing of ours. */
export function readStoredReplies(): StoredReply[] {
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(REPLIES_KEY) ?? '[]')
    return Array.isArray(parsed)
      ? parsed.filter(isStoredReply).map((row) => Object.assign(row, { reply: withDefaults(row.reply) }))
      : []
  } catch {
    return []
  }
}

/** Keeps `rows` for the next load, replacing what was kept. */
export function saveStoredReplies(rows: readonly StoredReply[]) {
  try {
    if (rows.length > 0) sessionStorage.setItem(REPLIES_KEY, JSON.stringify(rows))
    else sessionStorage.removeItem(REPLIES_KEY)
  } catch {
    // Without storage, a reload starts every conversation without a draft.
  }
}
