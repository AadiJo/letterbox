// What the last action did, in a toast for 5 s: "Marked done", "Archived" or "Moved to Trash",
// with Undo (or z). A new action replaces it. With no notice up, the toast offers Undo for a
// reply in its undo window instead (sending.ts), and z acts on whichever the toast shows.
//
// Undo is the core's: `undo` names the change the action made, and the core takes back exactly
// what that change altered. The renderer never builds an opposite command. While the core
// waits to answer, the toast says "Undoing…". When it refuses, the toast says why.

import type { ChangeId, MailboxId, ThreadId, UndoConflict, UndoField } from '@letterbox/protocol'
import { useSyncExternalStore } from 'react'
import type { Action } from './actions.ts'
import { client } from './core.ts'

/** The key that undoes the last action. */
export const UNDO_KEY = 'z'

/** How long a notice stays. */
const NOTICE_MS = 5000

/**
 * The toast's content: what was done, and the change Undo takes back, or null for a toast
 * that says why there is nothing to undo. `undoing` is true from z until the core answers the
 * undo. `icon` says what kind of word it is: done, waiting on the provider, or a refusal.
 * `serial` rises with each one, so a new toast replays its entrance.
 */
export type Notice = {
  serial: number
  threadId: ThreadId
  label: string
  change: ChangeId | null
  undoing: boolean
  icon: 'done' | 'clock' | 'info'
}

/** How a refusal names the provider of a conversation, and a mailbox. */
export type Names = { provider: (threadId: ThreadId) => string; mailbox: (id: MailboxId) => string | undefined }

let notice: Notice | null = null
let serial = 0
let expiry: ReturnType<typeof setTimeout> | undefined
const watchers = new Set<() => void>()

const setNotice = (next: Notice | null) => {
  clearTimeout(expiry)
  notice = next
  // An undo on its way keeps the toast until the core answers it.
  if (next && !next.undoing) expiry = setTimeout(() => setNotice(null), NOTICE_MS)
  watchers.forEach((watcher) => watcher())
}

/** What the toast says after `action`, or null for an action that says nothing. */
function labelFor(action: Action) {
  switch (action) {
    case 'done':
      return 'Marked done'
    case 'archive':
      return 'Archived'
    case 'trash':
      return 'Moved to Trash'
    case 'flag':
    case 'unread':
      return null
  }
}

/** Shows what `action`, which the core accepted as `change`, did to the conversation `threadId`. */
export function notify(action: Action, threadId: ThreadId, change: ChangeId) {
  const label = labelFor(action)
  if (!label) return
  serial += 1
  setNotice({ serial, threadId, label, change, undoing: false, icon: 'done' })
}

/** Says, for a while, that a reply's undo window ended before its undo reached the core (sending.ts). */
export function sayTooLate(threadId: ThreadId) {
  serial += 1
  setNotice({ serial, threadId, label: "Too late to undo. It's sending.", change: null, undoing: false, icon: 'clock' })
}

/** Whether the toast shows a notice. While it does, z and Undo act on it, not on a reply in its undo window (sending.ts). */
export const hasNotice = () => notice !== null

/** Takes the toast down. */
export const withdraw = () => setNotice(null)

/** Takes the toast down if it is about `threadId`, whose change the core took back. */
export const withdrawFor = (threadId: ThreadId) => {
  if (notice?.threadId === threadId) withdraw()
}

/** The field a refusal names, in the user's words. */
function fieldName(field: UndoField, names: Names) {
  switch (field.kind) {
    case 'mailbox':
      return `Its place in ${names.mailbox(field.mailboxId) ?? 'a mailbox'}`
    case 'unread':
      return 'Its read state'
    case 'flagged':
      return 'Its flag'
    case 'turn':
      return 'Its turn'
  }
}

/** Why the core refused an undo of a change to the conversation `threadId`, in the user's words. */
function refusal(conflict: UndoConflict | undefined, names: Names, threadId: ThreadId) {
  switch (conflict?.kind) {
    case 'outcome-unknown':
      return `Can't undo yet: waiting for ${names.provider(threadId)} to confirm`
    case 'partly-applied':
      return "Only part of this went through, so it can't be undone"
    case 'changed':
      return `${fieldName(conflict.field, names)} changed since, so it can't be undone`
    case 'mailbox-gone':
      return `${names.mailbox(conflict.mailboxId) ?? 'That mailbox'} is gone, so it can't be undone`
    case undefined:
      return "This can't be undone"
  }
}

/**
 * Undoes the action on the toast. The core may wait for the change's call to the provider
 * before it answers, so the toast says "Undoing…" until it does, with Undo still in place.
 * Resolves with the conversation once the core accepts, or null. A refusal says why in the
 * toast, unless a new action took the toast meanwhile.
 */
export async function undo(names: Names) {
  const taken = notice
  if (!taken?.change || taken.undoing) return null
  const undoing: Notice = { ...taken, label: 'Undoing…', undoing: true, icon: 'clock' }
  setNotice(undoing)
  const answer = await client.command({ kind: 'undo', change: taken.change }).catch(() => null)
  const ours = notice === undoing
  if (answer?.kind === 'accepted') {
    if (ours) withdraw()
    return taken.threadId
  }
  if (!ours) return null
  serial += 1
  const conflict = answer?.kind === 'rejected' ? answer.conflict : undefined
  const label = refusal(conflict, names, taken.threadId)
  const icon = conflict?.kind === 'outcome-unknown' ? 'clock' : 'info'
  setNotice({ serial, threadId: taken.threadId, label, change: null, undoing: false, icon })
  return null
}

/** The toast's content, or null. */
export function useNotice() {
  return useSyncExternalStore(
    (onChange) => {
      watchers.add(onChange)
      return () => void watchers.delete(onChange)
    },
    () => notice,
  )
}
