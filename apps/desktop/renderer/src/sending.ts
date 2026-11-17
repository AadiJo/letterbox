// A message's life from Send until the provider holds it: a reply, a new message or a
// forward. The only place the renderer sends mail or takes a send back, so every step follows
// the same rules:
//
//   - Send checks the draft (drafts.ts `check`) and shows a problem on its line before
//     anything reaches the core. The core checks again, and its refusal shows beside Send.
//   - Once the core accepts, the draft goes and the reply is the core's: the conversation
//     shows it at once, marked by its `delivery`. A new message or a forward starts a
//     conversation of its own, which is found as a merged one is (`relocate`).
//   - The core stores a send before it answers, so a lost answer does not mean it was not
//     sent. The draft then waits as Checking under its change id, which is kept across a
//     reload, and the next connection sends the same change again. The core answers a
//     repeated id from what it stored, so the reply goes at most once.
//   - Undo is offered exactly while the core shows the reply as held, on every screen and
//     after a reload. The core's own deadline ends it, through the update that shows the reply
//     going. No renderer timer decides it, and nothing here guesses an outcome.
//   - A conversation has at most one reply on its way. Until the core releases or settles it,
//     R there shows that reply read only, with Undo, and starts no second one. Undo puts back
//     exactly that reply, so there is never a second text to merge or to lose.
//   - Undo puts a new message or a forward back on the compose page (drafts.ts `COMPOSE`).
//   - An undo goes under a change id of its own, kept with the reply's text across a reload.
//     Until its answer arrives the toast says "Undoing…" and the text stays kept, even once the
//     core's update has taken the reply out of its conversation. With the answer lost, the next
//     connection sends the same undo again, and the core answers from what it stored: the reply
//     comes back to its editor only if the core took it back.

import type { ChangeId, Message, ThreadDetail, ThreadId } from '@letterbox/protocol'
import { useSyncExternalStore } from 'react'
import { client, command } from './core.ts'
import {
  check,
  commitTyping,
  COMPOSE,
  composerFor,
  type DraftKey,
  flag,
  homeOf,
  openReply,
  type Reply,
  replyFrom,
  restore,
  settle,
  showPage,
  submit,
  unsure,
} from './drafts.ts'
import { refusal } from './refusals.ts'
import { readStored, saveStored, type Stored } from './stored-sends.ts'
import { threadsMatching, watchThreadDetail } from './threads.ts'
import { sayTooLate } from './undo.ts'

/**
 * A reply the core accepted and has not released yet. `until` is its undo window's end by the
 * core's clock, once the conversation shows it held. Until then it is null, and Undo waits.
 * `located` is true while the core shows it held in `threadId`, and false while the renderer
 * looks for the conversation it moved to, or, for a new conversation, the one it starts
 * (`threadId` null until then). Undo stays off until it is found.
 */
export type Pending = {
  threadId: ThreadId | null
  change: ChangeId
  reply: Reply | null
  until: string | null
  located: boolean
}

/** A pending reply in its undo window, which the toast offers to take back. */
export type Offer = Pending & { until: string; threadId: ThreadId }

/**
 * What each send said, by change, so an undo or a retry gets back exactly what was written, and
 * the conversation that holds it, null for a new one not found yet.
 */
const replies = new Map<ChangeId, { threadId: ThreadId | null; reply: Reply }>()
/** A send the core took back, kept beside the draft where it goes back (`key`) until the user picks. */
export type Undone = { change: ChangeId; key: DraftKey; reply: Reply }

/** Sends whose answer was lost. Each is asked about again, under its change id, on the next connection. */
const unknown = new Set<ChangeId>()
/**
 * Undos the core has not answered, by the send each takes back, with each undo's own change id.
 * Its reply's text stays in `replies` until the answer comes, and one lost on the way is asked
 * for again under the same id on the next connection (`takeBack`).
 */
let undoing: ReadonlyMap<ChangeId, ChangeId> = new Map()
/**
 * Sends whose Undo was pressed and whose undo is not sent yet, while `undoSend` asks the core
 * where the reply is held. A second press meanwhile sends nothing. Never stored: until the
 * undo goes, there is no answer to lose.
 */
const preparing = new Set<ChangeId>()
/**
 * Replies the core took back while their conversation's draft had text. Each waits beside that
 * draft until the user restores it over the draft or discards it (`useUndone`).
 */
let undone: ReadonlyMap<ChangeId, Undone> = new Map()
/** Accepted replies being followed until the core shows them past their window, oldest first. */
let pending: ReadonlyMap<ChangeId, Pending> = new Map()
/** Conversations whose pending reply the user asked to see, with R or Reply. */
let shown: ReadonlySet<ThreadId> = new Set()
const watchers = new Set<() => void>()

const tell = () => watchers.forEach((watcher) => watcher())

const setPending = (change: ChangeId, next: Pending | null) => {
  const rest = new Map(pending)
  if (next) rest.set(change, next)
  else rest.delete(change)
  pending = rest
  // A conversation with nothing left on its way has nothing to show read only.
  if (!next) shown = new Set([...shown].filter((id) => [...rest.values()].some((other) => other.threadId === id)))
  tell()
}

/** A pending send its conversation shows. */
export type Located = Pending & { threadId: ThreadId }

const pendingIn = (threadId: ThreadId) =>
  [...pending.values()].findLast((entry): entry is Located => entry.threadId === threadId)

const isOffer = (entry: Pending): entry is Offer => entry.until !== null && entry.threadId !== null

/** The newest reply in its undo window whose undo has not been sent, or undefined. */
const offered = () =>
  [...pending.values()].findLast((entry): entry is Offer => isOffer(entry) && !undoing.has(entry.change))

// Session storage keeps the sends being followed, and the sends and undos with no known
// answer, across a reload. It may be missing or refuse. A held reply the reader shows is
// followed anyway (`adopt`), and a lost answer stays Checking, or Undoing…, until the page
// reloads. stored-sends.ts reads and writes the rows. This file decides what they hold.

/** Writes every send this file follows or keeps, as rows for the next load to read. */
function writeStored() {
  const entries = [
    ...[...unknown].map((change) => ({ change, phase: 'unknown' as const })),
    // A send with an undo on its way is stored once, as undoing.
    ...[...pending.keys()]
      .filter((change) => !undoing.has(change))
      .map((change) => ({ change, phase: 'followed' as const })),
    ...[...undoing].map(([change, undo]) => ({ change, phase: 'undoing' as const, undo })),
  ]
  const kept: Stored[] = entries.flatMap((entry) => {
    const sent = replies.get(entry.change)
    return sent ? [{ ...entry, ...sent }] : []
  })
  for (const { change, key, reply } of undone.values())
    kept.push({ change, threadId: key === COMPOSE ? null : key, reply, phase: 'undone' })
  saveStored(kept)
}

/** How to stop watching each pending send's conversation. */
const stops = new Map<ChangeId, () => void>()

/**
 * Starts following send `change` in `threadId` from revision `rev`, unless it is already
 * followed. With no conversation, as for a new one, it looks for the one that holds it.
 */
function follow(threadId: ThreadId | null, change: ChangeId, rev: number) {
  if (pending.has(change)) return
  setPending(change, { threadId, change, reply: replies.get(change)?.reply ?? null, until: null, located: false })
  writeStored()
  if (threadId) watch(change, threadId, rev)
  else void relocate(change, rev)
}

/** The core has released `change`: it is going, gone, failed or delivered. Nothing about it is pending now. */
function release(change: ChangeId) {
  stops.get(change)?.()
  setPending(change, null)
  writeStored()
}

/**
 * Moves pending send `change`, and where Undo puts it back, to `threadId`, the conversation
 * that holds it now, and watches it there from revision `rev`.
 */
function move(change: ChangeId, threadId: ThreadId, rev: number) {
  const current = pending.get(change)
  if (!current) return
  const sent = replies.get(change)
  if (sent) replies.set(change, { ...sent, threadId })
  setPending(change, { ...current, threadId, located: false })
  writeStored()
  watch(change, threadId, rev)
}

/**
 * Watches send `change` in conversation `threadId`, replacing any watch it had, from revision
 * `rev`: updates from before cannot show it yet. Held, it stays pending with its window's end.
 * A conversation the core removed was merged into another, which now holds it (`relocate`).
 * Anything else means the core released it.
 */
function watch(change: ChangeId, threadId: ThreadId, rev: number) {
  stops.get(change)?.()
  let ended = false
  let unwatch: (() => void) | undefined
  const end = () => {
    ended = true
    unwatch?.()
    if (stops.get(change) === end) stops.delete(change)
  }
  stops.set(change, end)
  const listener = (detail: ThreadDetail | null, at: number) => {
    if (ended || at < rev) return
    const delivery = detail?.messages.find((message) => message.delivery?.change === change)?.delivery
    const current = pending.get(change)
    if (delivery?.state === 'held') {
      if (current && (current.until !== delivery.until || !current.located))
        setPending(change, { ...current, until: delivery.until, located: true })
      return
    }
    end()
    if (detail !== null) return release(change)
    if (current) setPending(change, { ...current, located: false })
    void relocate(change, at)
  }
  unwatch = watchThreadDetail(threadId, listener)
  // The listener runs once inside `watchThreadDetail`, before `unwatch` is set.
  if (ended) unwatch()
}

/**
 * Finds the conversation that holds send `change`: after the core merged its own into another,
 * or the one a new message started. A merge joins only conversations with the same subject, so
 * the search is by the reply's. With no subject left, the newest conversations are searched.
 * Until it is found the send stays pending, and Undo stays offered, since the core still holds it.
 */
async function relocate(change: ChangeId, rev: number) {
  // Every leading prefix, as the core strips them when it compares subjects. Only the change id proves a match.
  const subject = replies.get(change)?.reply.subject.replace(/^(\s*(re|fwd?|aw|sv|antw)\s*:)+\s*/i, '') ?? ''
  const candidates = await threadsMatching(subject).catch(() => [])
  const details = await Promise.all(
    candidates.map((threadId) => client.query({ view: 'thread', threadId }).catch(() => null)),
  )
  if (!pending.has(change)) return
  const holder = details.find((detail) => detail?.messages.some((message) => message.delivery?.change === change))
  if (holder) move(change, holder.id, rev)
  else release(change)
}

/**
 * Sends `reply` under `change`, a new id unless this asks about an earlier send again, and
 * settles it from the core's answer: followed once accepted, back in the editor with the
 * reason once refused. With no answer it stays unknown, and its draft waits as Checking.
 */
async function deliver(id: DraftKey, reply: Reply, change: ChangeId | undefined) {
  const checked = check(reply)
  if ('problem' in checked) return flag(id, reply, checked.problem)
  const sent = command({ kind: 'send', draft: checked.draft }, change)
  const threadId = id === COMPOSE ? null : id
  replies.set(sent.change, { threadId, reply })
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
    return settle(id, { at: 'send', text: refusal(reply, answer.reason) })
  }
  settle(id, null)
  follow(threadId, sent.change, answer.rev)
}

// Every stored row is read before any is followed or sent again, since those write storage
// back, and a row not read yet would be left out.
const boot = readStored()
for (const row of boot) {
  const { change, threadId, reply } = row
  if (row.phase === 'undone') undone = new Map([...undone, [change, { change, key: homeOf(reply, threadId), reply }]])
  else replies.set(change, { threadId, reply })
  if (row.phase === 'undoing') undoing = new Map([...undoing, [change, row.undo]])
}
for (const row of boot) {
  if (row.phase === 'followed') follow(row.threadId, row.change, -1)
  else if (row.phase === 'unknown') void deliver(homeOf(row.reply, row.threadId), row.reply, row.change)
  else if (row.phase === 'undoing') void takeBack(row.change, null, row.undo)
}

/**
 * Follows the held replies in `thread`, such as one from before a reload whose storage was
 * lost. The reader calls it as the conversation changes, and R before it decides.
 */
export function adopt(thread: ThreadDetail) {
  for (const message of thread.messages) {
    const change = message.delivery?.state === 'held' ? message.delivery.change : null
    if (!change) continue
    // The reply belongs to this conversation now, whatever was cached, as after a merge.
    const reply = replies.get(change)?.reply ?? replyFrom(thread, message)
    if (reply) replies.set(change, { threadId: thread.id, reply })
    const current = pending.get(change)
    if (!current) follow(thread.id, change, -1)
    else if (current.threadId !== thread.id) move(change, thread.id, -1)
  }
}

/**
 * R, Reply and Reply all. With a reply of the user's on its way in `thread`, they show that
 * reply read only, with Undo, and start nothing, or reopen the draft the conversation already
 * has, which cannot be sent meanwhile (`sendReply`). Otherwise they open the editor (drafts.ts).
 */
export function startReply(thread: ThreadDetail, all: boolean) {
  adopt(thread)
  if (pendingIn(thread.id) && !composerFor(thread.id)) {
    shown = new Set([...shown, thread.id])
    return tell()
  }
  openReply(thread, all)
}

/** Folds the read-only view of `threadId`'s pending reply. Esc does this. */
export function hidePending(threadId: ThreadId) {
  if (!shown.has(threadId)) return
  shown = new Set([...shown].filter((id) => id !== threadId))
  tell()
}

const subscribe = (onChange: () => void) => {
  watchers.add(onChange)
  return () => void watchers.delete(onChange)
}

/** The newest reply in its undo window whose undo has not been sent, for the toast, or null. */
export function useSendOffer() {
  return useSyncExternalStore(subscribe, () => offered() ?? null)
}

/** True while an undo of a reply waits for the core's answer. The toast says "Undoing…" meanwhile. */
export function useUndoingSend() {
  return useSyncExternalStore(subscribe, () => undoing.size > 0)
}

/** `threadId`'s reply on its way, or null. While there is one, the conversation's draft cannot be sent. */
export function usePendingIn(threadId: ThreadId) {
  return useSyncExternalStore(subscribe, () => pendingIn(threadId) ?? null)
}

/** `threadId`'s reply on its way, while the user asked to see it, or null. */
export function useShownPending(threadId: ThreadId) {
  return useSyncExternalStore(subscribe, () => (shown.has(threadId) ? (pendingIn(threadId) ?? null) : null))
}

/**
 * Takes back a reply in its undo window: `change`, or else the newest, once it is located.
 * It asks the core which conversation holds the reply first, since a merge may have moved it,
 * and the reply comes back there, never to a conversation remembered from before. Resolves
 * with that conversation once the core accepts, or null. A press while an undo for the reply
 * is being prepared or is on its way sends nothing. The core's update that drops it ends the offer.
 */
export async function undoSend(change?: ChangeId) {
  const offer = change ? pending.get(change) : offered()
  if (!offer || !isOffer(offer) || !offer.located) return null
  if (undoing.has(offer.change) || preparing.has(offer.change)) return null
  preparing.add(offer.change)
  try {
    return await prepareUndo(offer)
  } finally {
    preparing.delete(offer.change)
  }
}

/** `undoSend` once `offer` is marked as preparing: finds where the reply is held, then takes it back there. */
async function prepareUndo(offer: Offer) {
  const held = await client.query({ view: 'thread', threadId: offer.threadId }).catch(() => null)
  const delivery = held?.messages.find((message) => message.delivery?.change === offer.change)?.delivery
  // Past its window already: an undo could only be refused.
  if (held && delivery && delivery.state !== 'held') {
    sayTooLate(held.id)
    return null
  }
  if (!held || !delivery) {
    // It moved since the last update. Undo waits until it is found again.
    const current = pending.get(offer.change)
    if (current) setPending(offer.change, { ...current, located: false })
    void relocate(offer.change, -1)
    return null
  }
  return takeBack(offer.change, held, undefined)
}

/**
 * Sends the undo of send `change` and acts on the core's answer. `again` is the change id of
 * an undo sent before whose answer was lost. The core stores an undo it accepts, and answers
 * that id again from what it stored. It stores no refusal, so an undo it refused, or never
 * got, runs again as a new undo: accepted inside the window, refused once it has ended.
 * `held` is the conversation that holds the reply now, or null after a reload, when the
 * reply's own conversation is used.
 *
 * Until the answer arrives the text stays kept, in storage too. Accepted, the reply goes back
 * in its editor, or, over a draft with text or one waiting on the core, waits beside it
 * (`useUndone`) and the draft stays. Refused, it is the core's to send. Resolves with the
 * reply's conversation once the core accepts, or null.
 */
async function takeBack(change: ChangeId, held: ThreadDetail | null, again: ChangeId | undefined) {
  const asked = command({ kind: 'undo', change }, again)
  undoing = new Map([...undoing, [change, asked.change]])
  writeStored()
  tell()
  const answer = await asked.answer.catch(() => null)
  // No answer: the core may have taken it back. The text stays kept under this undo, and the next connection asks again.
  if (!answer) return null
  const rest = new Map(undoing)
  rest.delete(change)
  undoing = rest
  const sent = replies.get(change)
  const threadId = held?.id ?? sent?.threadId ?? null
  if (answer.kind === 'rejected') {
    writeStored()
    tell()
    // The core refuses an undo once the window has ended, though the update saying so may still be on its way.
    if (answer.reason === 'conflict' && threadId) sayTooLate(threadId)
    return null
  }
  replies.delete(change)
  // A new message or a forward goes back on the compose page, and no conversation opens.
  const home = sent && homeOf(sent.reply, threadId)
  if (sent && home) {
    if (threadId) hidePending(threadId)
    const draft = composerFor(home)
    const free = !draft || draft.reply.text.trim() === ''
    if (!free || !restore(home, sent.reply)) {
      undone = new Map([...undone, [change, { change, key: home, reply: sent.reply }]])
      // Opens the draft, folded or not, so the choice shows beside it.
      if (home === COMPOSE) showPage(true)
      else if (held) openReply(held, false)
    }
  }
  writeStored()
  tell()
  return home === COMPOSE ? null : threadId
}

/** The oldest send undone beside the draft `key`, or null. */
export function useUndone(key: DraftKey) {
  return useSyncExternalStore(subscribe, () => [...undone.values()].find((kept) => kept.key === key) ?? null)
}

/** Puts the undone reply `change` in the editor, over the conversation's draft. The user chose this. */
export function restoreUndone(change: ChangeId) {
  const kept = undone.get(change)
  // Kept until it lands: a draft waiting on the core takes nothing (drafts.ts `restore`).
  if (kept && restore(kept.key, kept.reply)) dropUndone(change)
}

/** Throws the undone reply `change` away. The user chose this. */
export function dropUndone(change: ChangeId) {
  const rest = new Map(undone)
  rest.delete(change)
  undone = rest
  writeStored()
  tell()
}

/**
 * Sends the open draft `id`, a conversation's or the compose page's. Resolves once the core has
 * answered: the draft is gone and the conversation shows the message, the editor shows why it
 * did not go, or, with the answer lost, the draft waits as Checking.
 */
export async function sendReply(id: DraftKey) {
  const composer = composerFor(id)
  // One reply on its way per conversation: this draft waits until the core releases the other.
  if (composer?.state !== 'open' || (id !== COMPOSE && pendingIn(id))) return
  await deliver(id, commitTyping(composer.reply), undefined)
}

/**
 * Opens the editor on a reply that was not sent, with what it said, for a new Send. With
 * another reply on its way, or a draft already there, it shows that instead and replaces nothing.
 */
export function editAndSendAgain(thread: ThreadDetail, message: Message) {
  const change = message.delivery?.change
  const kept = change && replies.get(change)?.reply
  // A new message or a forward is written again on the compose page.
  if (kept && kept.inReplyTo === null) return void restore(COMPOSE, kept)
  const reply = kept || replyFrom(thread, message)
  if (pendingIn(thread.id) || composerFor(thread.id)) return startReply(thread, false)
  if (reply) restore(thread.id, reply)
}
