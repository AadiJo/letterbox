// What Updates does to all of one sender's conversations at once: Mark read and Archive all,
// from the reader's toolbar, the hovered row, or the toast after an unsubscribe.

import type { MailboxId, SenderSummary } from '@letterbox/protocol'
import { commandFor, type Mail, send } from './actions.ts'
import { lostReason } from './core.ts'
import { threadsOf } from './threads.ts'
import { notifySender } from './undo.ts'

/**
 * Marks all of `sender`'s mail in `inbox` read, or archives all of it: one command naming every
 * conversation the core lists for it, built as the toolbar's would be for the first. The toast
 * then says what it did, with Undo. Resolves with whether the core took it. Off while the core
 * is lost, as the toolbar's actions are (LostCore.tsx).
 */
export async function actOnSender(sender: SenderSummary, kind: 'read' | 'archive', inbox: MailboxId, mail: Mail) {
  if (lostReason() !== null) return false
  const filter = { mailboxId: inbox, sender: sender.id, ...(kind === 'read' && { unread: true }) }
  const threads = await threadsOf(filter, kind === 'read' ? sender.unread : sender.threads)
  const [first] = threads
  const command = first && commandFor(kind === 'read' ? 'unread' : 'archive', first, mail)
  if (!first || (command?.kind !== 'set-flags' && command?.kind !== 'set-mailboxes')) return false
  const change = await send({ ...command, threadIds: threads.map((thread) => thread.id) })
  if (!change) return false
  notifySender(kind === 'read' ? 'Marked read' : 'Archived', sender.name ?? sender.address, first.id, change)
  return true
}
