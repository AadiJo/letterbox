// What the last action did, in a toast for 5 s: "Marked done", "Archived" or "Moved to Trash",
// with Undo (or z). A new action replaces it.
//
// Undo is the core's: `undo` names the change the action made, and the core takes back exactly
// what that change altered. The renderer never builds an opposite command. When the core will
// not undo it yet, or ever, because the provider has not confirmed it or took only part of it,
// the toast says so instead.

import type { ChangeId, ThreadId, UndoConflict } from '@letterbox/protocol'
import { useSyncExternalStore } from 'react'
import type { Action } from './actions.ts'
import { client } from './core.ts'

/** The key that undoes the last action. */
export const UNDO_KEY = 'z'

/** How long a notice stays. */
const NOTICE_MS = 5000

/**
 * The toast's content: what was done, and the change Undo takes back, or null for a toast
 * that says why an undo was refused. `serial` rises with each one, so a new toast replays its entrance.
 */
export type Notice = { serial: number; threadId: ThreadId; label: string; change: ChangeId | null }

let notice: Notice | null = null
let serial = 0
let expiry: ReturnType<typeof setTimeout> | undefined
const watchers = new Set<() => void>()

const setNotice = (next: Notice | null) => {
  clearTimeout(expiry)
  notice = next
  if (next) expiry = setTimeout(() => setNotice(null), NOTICE_MS)
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
  setNotice({ serial, threadId, label, change })
}

/** Takes the toast down. */
export const withdraw = () => setNotice(null)

/** Takes the toast down if it is about `threadId`, whose change the core took back. */
export const withdrawFor = (threadId: ThreadId) => {
  if (notice?.threadId === threadId) withdraw()
}

/** Why the core refused an undo, in the user's words, for the reasons the user can do nothing about now. */
function refusal(conflict: UndoConflict | undefined, provider: string) {
  switch (conflict?.kind) {
    case 'outcome-unknown':
      return `Can't undo yet: waiting for ${provider} to confirm`
    case 'partly-applied':
      return "Only part of this went through, so it can't be undone"
    default:
      return null
  }
}

/**
 * Undoes the action on the toast. Resolves with its conversation once the core accepts, or
 * null. A refusal for a reason the user should know shows in the toast, naming the provider
 * `providerOf` gives for the conversation.
 */
export async function undo(providerOf: (threadId: ThreadId) => string) {
  const taken = notice
  if (!taken?.change) return null
  withdraw()
  const answer = await client.command({ kind: 'undo', change: taken.change }).catch(() => null)
  if (answer?.kind === 'accepted') return taken.threadId
  const why = answer?.kind === 'rejected' ? refusal(answer.conflict, providerOf(taken.threadId)) : null
  if (why) {
    serial += 1
    setNotice({ serial, threadId: taken.threadId, label: why, change: null })
  }
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
