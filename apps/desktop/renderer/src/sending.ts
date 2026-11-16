// A reply's life from Send until the provider holds it. The only place the renderer sends
// mail or takes a send back, so every step follows the same rules:
//
//   - Send checks the draft (drafts.ts `check`) and shows a problem on its line before
//     anything reaches the core. The core checks again, and its refusal shows beside Send.
//   - Once the core accepts, the draft goes and the reply is the core's: the conversation
//     shows it at once, marked by its `delivery`. While the core holds it in the undo window,
//     the toast offers Undo. Undo puts the text back in the editor.
//   - The window's end, a refusal, or delivery comes only from the core's views. Nothing
//     here guesses an outcome or counts down on its own.

import type { ChangeId, Message, Refusal, ThreadDetail, ThreadId } from '@letterbox/protocol'
import { client } from './core.ts'
import { check, commitTyping, composerFor, flag, type Reply, replyFrom, restore, settle, submit } from './drafts.ts'
import { watchThreadDetail } from './threads.ts'
import { offerUndoSend, withdrawSend } from './undo.ts'

/** Why a reply did not go, in words, for the editor and for a message marked Not sent. */
export const REFUSALS = {
  'not-permitted': 'This account is not allowed to send right now.',
  'not-supported': 'This account cannot send mail.',
  'unknown-target': 'The message it answers is no longer here.',
  conflict: 'Another change to this conversation got in the way.',
  'refused-by-provider': 'The mail server refused it.',
  invalid: 'An address or the subject is not one the core can send.',
  unconfirmed: 'It may not have been sent. Check Sent before sending again.',
} as const satisfies Record<Refusal, string>

/** Replies the core accepted in this session, by change, so an undo or a retry gets back exactly what was written. */
const accepted = new Map<ChangeId, { threadId: ThreadId; reply: Reply }>()

/**
 * Sends the open draft of conversation `id`. Resolves once the core has answered: the
 * draft is gone and the conversation shows the reply, or the editor shows why it did not go.
 */
export async function sendReply(id: ThreadId) {
  const composer = composerFor(id)
  if (composer?.state !== 'open') return
  const reply = commitTyping(composer.reply)
  const checked = check(reply)
  if ('problem' in checked) return flag(id, reply, checked.problem)
  if (!submit(id, reply)) return
  const answer = await client.command({ kind: 'send', draft: checked.draft }).catch(() => null)
  if (!answer) return settle(id, { at: 'send', text: 'Lost the core, so nothing was sent. Your reply is still here.' })
  if (answer.kind === 'rejected') return settle(id, { at: 'send', text: REFUSALS[answer.reason] })
  accepted.set(answer.change, { threadId: id, reply })
  settle(id, null)
  follow(id, answer.change, answer.rev)
}

/**
 * Offers Undo while the core holds send `change` in its window, and takes the offer down as
 * soon as the conversation shows it anything else: going, gone, failed or delivered. Updates
 * from before the core accepted it (`rev`) are skipped, since they cannot show it yet.
 */
function follow(threadId: ThreadId, change: ChangeId, rev: number) {
  let offered = false
  let finished = false
  let stop: (() => void) | undefined
  const listener = (detail: ThreadDetail | null, at: number) => {
    if (finished || at < rev) return
    const delivery = detail?.messages.find((message) => message.delivery?.change === change)?.delivery
    if (delivery?.state === 'held') {
      if (!offered) offerUndoSend(threadId, change, delivery.until, () => undone(change))
      offered = true
      return
    }
    finished = true
    withdrawSend(change)
    stop?.()
  }
  const unwatch = watchThreadDetail(threadId, listener)
  // The listener runs once inside `watchThreadDetail`, before `stop` is set.
  if (finished) unwatch()
  else stop = unwatch
}

/** The core took send `change` back: its text returns to the editor. */
function undone(change: ChangeId) {
  const sent = accepted.get(change)
  if (!sent) return
  accepted.delete(change)
  restore(sent.threadId, sent.reply)
}

/** Opens the editor on a reply that was not sent, with what it said, for a new Send. */
export function editAndSendAgain(thread: ThreadDetail, message: Message) {
  const change = message.delivery?.change
  const reply = (change && accepted.get(change)?.reply) ?? replyFrom(thread, message)
  if (reply) restore(thread.id, reply)
}
