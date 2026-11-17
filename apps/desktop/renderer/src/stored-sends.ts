// The sends sending.ts keeps across a reload, in session storage: their rows, how a row is
// checked when read, and the read and the write. Storage may be missing or refuse, and then
// nothing is kept. sending.ts decides what the rows hold and what each phase means.

import type { ChangeId, ThreadId } from '@letterbox/protocol'
import type { Reply } from './drafts.ts'

const KEY = 'letterbox.sends'

/** One send in storage, by the phase it was in. Each phase is one way sending.ts follows or keeps it. */
export type Stored = { change: ChangeId; threadId: ThreadId; reply: Reply } & (
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

/** A stored send, as `saveStored` wrote it. Anything else in storage is ignored. */
function isStored(value: unknown): value is Stored {
  if (!isObject(value) || typeof value.change !== 'string' || typeof value.threadId !== 'string') return false
  const { phase } = value
  const known =
    phase === 'unknown' ||
    phase === 'followed' ||
    phase === 'undone' ||
    (phase === 'undoing' && typeof value.undo === 'string')
  if (!known) return false
  const { reply } = value
  return (
    isObject(reply) &&
    ['accountId', 'inReplyTo', 'subject', 'text'].every((key) => typeof reply[key] === 'string') &&
    isRecipients(reply.to) &&
    isRecipients(reply.cc) &&
    isRecipients(reply.bcc) &&
    isObject(reply.typing) &&
    typeof reply.bccLost === 'boolean'
  )
}

/** The rows the last load saved, at boot. Empty when storage is missing, refuses, or holds nothing of ours. */
export function readStored(): Stored[] {
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter(isStored) : []
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
