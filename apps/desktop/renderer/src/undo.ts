// What the last action did, in a toast for 5 s: "Marked done" with Undo (or z), or
// "Archived" and "Moved to Trash" with nothing to undo yet. A new action replaces it.
// A reply the core holds in its undo window shows "Sending" with Undo until the window ends.
//
// Only Done can be undone: setting the turn back to the one the conversation had is exact.
// Archive and Trash wait for the core's own `undo`, which answers not-supported today.

import type { ChangeId, Command, ThreadId, ThreadSummary } from '@letterbox/protocol'
import { useSyncExternalStore } from 'react'
import { type Action, send } from './actions.ts'
import { now } from './clock.ts'

/** The key that undoes the last undoable action. */
export const UNDO_KEY = 'z'

/** How long a notice stays. */
const NOTICE_MS = 5000

type SetTurn = Extract<Command, { kind: 'set-turn' }>
type UndoSend = Extract<Command, { kind: 'undo' }>

/**
 * What the toast says, and the command that undoes it if there is one. A send's toast stays
 * until its window ends at `until`, and `onUndone` runs once the core takes the send back.
 */
type Said =
  | { label: 'Marked done'; undo: SetTurn }
  | { label: 'Archived' | 'Moved to Trash'; undo: null }
  | { label: 'Sending'; undo: UndoSend; until: string; onUndone: () => void }

/** The toast's content. `serial` rises with each one, so a new toast replays its entrance. */
export type Notice = { serial: number; threadId: ThreadId } & Said

let notice: Notice | null = null
let serial = 0
let expiry: ReturnType<typeof setTimeout> | undefined
const watchers = new Set<() => void>()

const setNotice = (next: Notice | null) => {
  clearTimeout(expiry)
  notice = next
  if (next)
    expiry = setTimeout(
      () => setNotice(null),
      next.label === 'Sending' ? Math.max(0, Date.parse(next.until) - now()) : NOTICE_MS,
    )
  watchers.forEach((watcher) => watcher())
}

/**
 * What the toast says after `action` on `before`, or null for an action that says nothing.
 * Done's undo gives the turn back to the user if they set it, or to the rule if the rule gave it.
 */
function said(action: Action, before: ThreadSummary): Said | null {
  switch (action) {
    case 'done': {
      const turn = before.turn.reason === 'set-by-user' ? before.turn.holder : 'auto'
      return { label: 'Marked done', undo: { kind: 'set-turn', threadIds: [before.id], turn } }
    }
    case 'archive':
      return { label: 'Archived', undo: null }
    case 'trash':
      return { label: 'Moved to Trash', undo: null }
    case 'flag':
    case 'unread':
      return null
  }
}

/** Shows what `action`, which the core accepted, did to `before`. */
export function notify(action: Action, before: ThreadSummary) {
  const body = said(action, before)
  if (!body) return
  serial += 1
  setNotice({ serial, threadId: before.id, ...body })
}

/** Shows "Sending" with Undo for a send the core holds until `until`. sending.ts calls this. */
export function offerUndoSend(threadId: ThreadId, change: ChangeId, until: string, onUndone: () => void) {
  serial += 1
  setNotice({ serial, threadId, label: 'Sending', undo: { kind: 'undo', change }, until, onUndone })
}

/** Takes the toast down if it offers to undo the send `change`, whose window has ended. */
export const withdrawSend = (change: ChangeId) => {
  if (notice?.label === 'Sending' && notice.undo.change === change) withdraw()
}

/** Takes the toast down. */
export const withdraw = () => setNotice(null)

/** Takes the toast down if it is about `threadId`, whose change the core took back. */
export const withdrawFor = (threadId: ThreadId) => {
  if (notice?.threadId === threadId) withdraw()
}

/** Undoes the action on the toast, if it can be undone. Resolves with its conversation once the core accepts, or null. */
export async function undo() {
  const taken = notice
  if (!taken?.undo) return null
  withdraw()
  if (!(await send(taken.undo))) return null
  if (taken.label === 'Sending') taken.onUndone()
  return taken.threadId
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
