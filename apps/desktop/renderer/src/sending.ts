// A reply's life from Send until the provider holds it. The only place the renderer sends
// mail or takes a send back, so every step follows the same rules:
//
//   - Send checks the draft (drafts.ts `check`) and shows a problem on its line before
//     anything reaches the core. The core checks again, and its refusal shows beside Send.
//   - Once the core accepts, the draft goes and the reply is the core's: the conversation
//     shows it at once, marked by its `delivery`.
//   - The core stores a send before it answers, so a lost answer does not mean it was not
//     sent. The draft then waits as Checking under its change id, which is kept across a
//     reload, and the next connection sends the same change again. The core answers a
//     repeated id from what it stored, so the reply goes at most once.
//   - Undo is offered exactly while the core shows the reply as held, on every screen and
//     after a reload. The core's own deadline ends it, through the update that shows the reply
//     going. No renderer timer decides it, and nothing here guesses an outcome.

import type { ChangeId, Message, Refusal, ThreadDetail, ThreadId } from '@letterbox/protocol'
import { useSyncExternalStore } from 'react'
import { send } from './actions.ts'
import { command } from './core.ts'
import {
  check,
  commitTyping,
  composerFor,
  flag,
  type Reply,
  replyFrom,
  restore,
  settle,
  submit,
  unsure,
} from './drafts.ts'
import { watchThreadDetail } from './threads.ts'

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

/** A reply the core holds in its undo window right now, until `until` by its clock. */
export type Offer = { threadId: ThreadId; change: ChangeId; until: string }

/** What each reply said, by change, so an undo or a retry gets back exactly what was written. */
const replies = new Map<ChangeId, { threadId: ThreadId; reply: Reply }>()
/** Sends whose conversation is watched until the core shows them past their window. */
const followed = new Set<ChangeId>()
/** Sends whose answer was lost. Each is asked about again, under its change id, on the next connection. */
const unknown = new Set<ChangeId>()
/** The held replies, oldest first. The toast offers Undo for the newest. */
let offers: readonly Offer[] = []
const offerWatchers = new Set<() => void>()

const setOffer = (change: ChangeId, offer: Offer | null) => {
  const others = offers.filter((existing) => existing.change !== change)
  const current = offers.find((existing) => existing.change === change)
  if (offer === null ? current === undefined : current?.until === offer.until) return
  offers = offer ? [...others, offer] : others
  offerWatchers.forEach((watcher) => watcher())
}

// Session storage keeps the sends being followed, and those with no known answer, across a
// reload. It may be missing or refuse. A held reply the reader shows is followed anyway
// (`adopt`), and a lost answer stays Checking until the page reloads.

const STORED = 'letterbox.sends'

type Stored = { change: ChangeId; threadId: ThreadId; reply: Reply; phase: 'unknown' | 'followed' }

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null
const isRecipients = (value: unknown) =>
  Array.isArray(value) &&
  value.every(
    (person) =>
      isObject(person) &&
      typeof person.address === 'string' &&
      (person.name === null || typeof person.name === 'string'),
  )

/** A stored send, as this file wrote it. Anything else in storage is ignored. */
function isStored(value: unknown): value is Stored {
  if (!isObject(value) || typeof value.change !== 'string' || typeof value.threadId !== 'string') return false
  if (value.phase !== 'unknown' && value.phase !== 'followed') return false
  const { reply } = value
  return (
    isObject(reply) &&
    ['accountId', 'inReplyTo', 'subject', 'text'].every((key) => typeof reply[key] === 'string') &&
    isRecipients(reply.to) &&
    isRecipients(reply.cc) &&
    isRecipients(reply.bcc) &&
    isObject(reply.typing)
  )
}

function readStored(): Stored[] {
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(STORED) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter(isStored) : []
  } catch {
    return []
  }
}

function writeStored() {
  const entries = [
    ...[...unknown].map((change) => ({ change, phase: 'unknown' as const })),
    ...[...followed].map((change) => ({ change, phase: 'followed' as const })),
  ]
  const kept: Stored[] = entries.flatMap((entry) => {
    const sent = replies.get(entry.change)
    return sent ? [{ ...entry, ...sent }] : []
  })
  try {
    sessionStorage.setItem(STORED, JSON.stringify(kept))
  } catch {
    // Without storage, a reload finds held replies only as the reader shows them.
  }
}

/**
 * Follows send `change` in its conversation from revision `rev`: offered while held, and
 * done with once the core shows it anything else (going, gone, failed or delivered).
 * Updates from before the core accepted it cannot show it yet, so they are skipped.
 */
function follow(threadId: ThreadId, change: ChangeId, rev: number) {
  if (followed.has(change)) return
  followed.add(change)
  writeStored()
  let finished = false
  let stop: (() => void) | undefined
  const listener = (detail: ThreadDetail | null, at: number) => {
    if (finished || at < rev) return
    const delivery = detail?.messages.find((message) => message.delivery?.change === change)?.delivery
    if (delivery?.state === 'held') return setOffer(change, { threadId, change, until: delivery.until })
    finished = true
    setOffer(change, null)
    followed.delete(change)
    writeStored()
    stop?.()
  }
  const unwatch = watchThreadDetail(threadId, listener)
  // The listener runs once inside `watchThreadDetail`, before `stop` is set.
  if (finished) unwatch()
  else stop = unwatch
}

/**
 * Sends `reply` under `change`, a new id unless this asks about an earlier send again, and
 * settles it from the core's answer: followed once accepted, back in the editor with the
 * reason once refused. With no answer it stays unknown, and its draft waits as Checking.
 */
async function deliver(id: ThreadId, reply: Reply, change: ChangeId | undefined) {
  const checked = check(reply)
  if ('problem' in checked) return flag(id, reply, checked.problem)
  const sent = command({ kind: 'send', draft: checked.draft }, change)
  replies.set(sent.change, { threadId: id, reply })
  unknown.add(sent.change)
  writeStored()
  if (change) unsure(id, reply, sent.change)
  else submit(id, reply, sent.change)
  const answer = await sent.answer.catch(() => null)
  if (!answer) return unsure(id, reply, sent.change)
  unknown.delete(sent.change)
  if (answer.kind === 'rejected') {
    replies.delete(sent.change)
    writeStored()
    return settle(id, { at: 'send', text: REFUSALS[answer.reason] })
  }
  settle(id, null)
  follow(id, sent.change, answer.rev)
}

for (const stored of readStored()) {
  replies.set(stored.change, { threadId: stored.threadId, reply: stored.reply })
  if (stored.phase === 'followed') follow(stored.threadId, stored.change, -1)
  else void deliver(stored.threadId, stored.reply, stored.change)
}

/** Follows a held reply the reader shows, as one from before a reload whose storage was lost. */
export function adopt(thread: ThreadDetail, message: Message) {
  const change = message.delivery?.change
  if (!change || followed.has(change)) return
  const reply = replyFrom(thread, message)
  if (!replies.has(change) && reply) replies.set(change, { threadId: thread.id, reply })
  follow(thread.id, change, -1)
}

/** The newest reply in its undo window, or null. */
export function useSendOffer() {
  return useSyncExternalStore(
    (onChange) => {
      offerWatchers.add(onChange)
      return () => void offerWatchers.delete(onChange)
    },
    () => offers.at(-1) ?? null,
  )
}

/**
 * Takes back the newest reply in its undo window. Resolves with its conversation once the
 * core accepts, and its text is back in the editor, or null when there is none or the window
 * closed first. The offer goes with the core's update that drops the reply.
 */
export async function undoSend() {
  const offer = offers.at(-1)
  if (!offer || !(await send({ kind: 'undo', change: offer.change }))) return null
  const sent = replies.get(offer.change)
  replies.delete(offer.change)
  if (sent) restore(sent.threadId, sent.reply)
  return offer.threadId
}

/**
 * Sends the open draft of conversation `id`. Resolves once the core has answered: the
 * draft is gone and the conversation shows the reply, the editor shows why it did not go,
 * or, with the answer lost, the draft waits as Checking.
 */
export async function sendReply(id: ThreadId) {
  const composer = composerFor(id)
  if (composer?.state !== 'open') return
  await deliver(id, commitTyping(composer.reply), undefined)
}

/** Opens the editor on a reply that was not sent, with what it said, for a new Send. */
export function editAndSendAgain(thread: ThreadDetail, message: Message) {
  const change = message.delivery?.change
  const reply = (change && replies.get(change)?.reply) ?? replyFrom(thread, message)
  if (reply) restore(thread.id, reply)
}
