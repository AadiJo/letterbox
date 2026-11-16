// What the last action did, in a toast for 5 s: "Marked done", "Archived" or "Moved to Trash",
// with Undo (or z). A new action replaces it.
//
// Undo is the core's: `undo` names the change the action made, and the core takes back exactly
// what that change altered. The renderer never builds an opposite command.

import type { ChangeId, ThreadId } from '@letterbox/protocol'
import { useSyncExternalStore } from 'react'
import { type Action, send } from './actions.ts'

/** The key that undoes the last action. */
export const UNDO_KEY = 'z'

/** How long a notice stays. */
const NOTICE_MS = 5000

type Label = 'Marked done' | 'Archived' | 'Moved to Trash'

/** The toast's content: what was done, and the change Undo takes back. `serial` rises with each one, so a new toast replays its entrance. */
export type Notice = { serial: number; threadId: ThreadId; label: Label; change: ChangeId }

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
function labelFor(action: Action): Label | null {
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

/** Undoes the action on the toast. Resolves with its conversation once the core accepts, or null. */
export async function undo() {
  const taken = notice
  if (!taken) return null
  withdraw()
  return (await send({ kind: 'undo', change: taken.change })) ? taken.threadId : null
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
