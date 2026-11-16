// Undoable actions: Done, archive and move to Trash. The newest one is offered in a toast
// for 5 s, and its Undo button or z takes it back. A new action replaces the offer.
//
// The core answers an `undo` command with not-supported today (crates/core/src/dispatch.rs),
// so Undo sends the opposite command, worked out from the conversation as it was before.

import type { Command, Role, ThreadId, ThreadSummary } from '@letterbox/protocol'
import { useSyncExternalStore } from 'react'
import { type Action, type Mail, send } from './actions.ts'

/** What the toast says after each undoable action. */
const LABELS = { done: 'Marked done', archive: 'Archived', trash: 'Moved to Trash' } as const satisfies Partial<
  Record<Action, string>
>

type Undoable = keyof typeof LABELS

const isUndoable = (action: Action): action is Undoable => action in LABELS

/** Mailboxes Undo never puts a trashed conversation back in. The provider files Sent and Drafts itself. */
const NOT_BACK: ReadonlySet<Role | null> = new Set(['trash', 'sent', 'drafts'])

/** The key that undoes the offered action. */
export const UNDO_KEY = 'z'

/** How long an offer stays. */
const OFFER_MS = 5000

/** The action on offer. `serial` rises with each one, so a new toast replays its entrance. */
export type Offer = { serial: number; label: (typeof LABELS)[Undoable]; threadId: ThreadId; reverse: Command }

let offer: Offer | null = null
let serial = 0
let expiry: ReturnType<typeof setTimeout> | undefined
const watchers = new Set<() => void>()

const setOffer = (next: Offer | null) => {
  clearTimeout(expiry)
  offer = next
  if (next) expiry = setTimeout(() => setOffer(null), OFFER_MS)
  watchers.forEach((watcher) => watcher())
}

/**
 * The command that puts `before` back as it was after the core accepted `command`.
 * A turn the user set goes back to them, and one the rule gave goes back to the rule.
 */
function reverse(command: Command, before: ThreadSummary, mail: Mail): Command | null {
  const threadIds = [before.id]
  switch (command.kind) {
    case 'set-turn':
      return { kind: 'set-turn', threadIds, turn: before.turn.reason === 'set-by-user' ? before.turn.holder : 'auto' }
    case 'set-mailboxes':
      return { kind: 'set-mailboxes', threadIds, add: command.remove, remove: command.add }
    case 'trash': {
      const own = mail.mailboxes.filter((mailbox) => mailbox.accountId === before.accountId)
      const trash = own.find((mailbox) => mailbox.role === 'trash')
      if (!trash) return null
      // Back to where it was, Inbox first.
      const back = own
        .filter((mailbox) => before.mailboxIds.includes(mailbox.id) && !NOT_BACK.has(mailbox.role))
        .toSorted((a, b) => Number(b.role === 'inbox') - Number(a.role === 'inbox'))
        .map((mailbox) => mailbox.id)
      // A folder account keeps a message in one place, so it goes back to one of them.
      const multiple = mail.accounts.find((account) => account.id === before.accountId)?.can.multipleMailboxes
      return { kind: 'set-mailboxes', threadIds, add: multiple ? back : back.slice(0, 1), remove: [trash.id] }
    }
    default:
      return null
  }
}

/** Offers to undo `action`, which the core accepted as `command` for `before`. Other actions offer nothing. */
export function offerUndo(action: Action, before: ThreadSummary, command: Command, mail: Mail) {
  if (!isUndoable(action)) return
  const back = reverse(command, before, mail)
  if (!back) return
  serial += 1
  setOffer({ serial, label: LABELS[action], threadId: before.id, reverse: back })
}

/** Withdraws the offer. */
export const withdraw = () => setOffer(null)

/** Undoes the offered action. Resolves with its conversation once the core accepts, or null. */
export async function undo() {
  const taken = offer
  if (!taken) return null
  setOffer(null)
  return (await send(taken.reverse)) ? taken.threadId : null
}

/** The action on offer, or null. */
export function useOffer() {
  return useSyncExternalStore(
    (onChange) => {
      watchers.add(onChange)
      return () => void watchers.delete(onChange)
    },
    () => offer,
  )
}
