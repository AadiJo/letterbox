// Unsubscribing from a sender (pick A): the confirm says what it tells the sender and how the
// request goes out, the `unsubscribe` command starts it, and the core holds it for the undo
// window before it carries it out (protocol `Unsubscribed`). The toast follows the sender's
// row: Undo while held, quiet while sending, then "Unsubscribed" with Archive all, or, when only
// the sender's page is left, a button that opens it. Opening it is the person's own click,
// through the shell (ShellBridge.openPage), and never counts as done.
//
// Only Updates rows carry where an unsubscribe has got, so a conversation reads its sender's row
// from a senders view of that one address (`useSenderRow`). Undo comes only from the row's held
// state and its change, so it is there after a reload too.

import type {
  AccountId,
  ChangeId,
  MailboxId,
  MessageId,
  Refusal,
  ThreadDetail,
  Unsubscribe,
  Unsubscribed,
} from '@letterbox/protocol'
import { useSyncExternalStore } from 'react'
import type { Mail } from './actions.ts'
import { client, commandSettled, lostReason, useView } from './core.ts'
import { noticeSerial } from './undo.ts'

/** The key, with Shift, that unsubscribes from the open sender or conversation's sender. */
export const UNSUBSCRIBE_KEY = 'U'

/** What one unsubscribe is about: the message whose target it uses, its sender, and the account it goes from. */
export type Target = {
  messageId: MessageId
  accountId: AccountId
  /** The sender as the person knows it: a name, or the address. */
  sender: string
  address: string
  /** The account's address, which the sender learns is read. */
  me: string
  /** The inbox whose Updates rows say where it has got. */
  inbox: MailboxId
  unsubscribe: Unsubscribe
}

/**
 * The target in a conversation: its newest message from someone else that names a way to
 * unsubscribe, with the account's address and inbox. Null when there is none.
 */
export function targetIn(thread: ThreadDetail | null | undefined, mail: Mail): Target | null {
  const message = thread?.messages.findLast((one) => !one.from.isMe && one.unsubscribe !== null)
  const account = mail.accounts.find((one) => one.id === thread?.accountId)
  const inbox = mail.mailboxes.find((one) => one.role === 'inbox' && one.accountId === account?.id)
  if (!thread || !message?.unsubscribe || !account || !inbox) return null
  return {
    messageId: message.id,
    accountId: thread.accountId,
    sender: message.from.name ?? message.from.address,
    address: message.from.address,
    me: account.address,
    inbox: inbox.id,
    unsubscribe: message.unsubscribe,
  }
}

/** A URL's host, for saying which page opens. */
export const hostOf = (url: string) => URL.parse(url)?.host ?? url

/**
 * The confirm's line on how the request goes out, from the target the core reports. A one-click
 * goes out as such only if its signature checks out once confirmed, which the core decides
 * then, so the line says what happens if it cannot.
 */
export function howItGoes(target: Target) {
  const { unsubscribe: way, sender, me } = target
  switch (way.method) {
    case 'one-click':
      return `Letterbox asks ${sender} to stop. If it can’t do that directly, it emails them from ${me}, or gives you their page.`
    case 'mailto':
      return `Letterbox emails ${sender} from ${me}.`
    case 'web':
      return `Letterbox can’t ask for you. It keeps the page, so you can open ${hostOf(way.url)} when you choose.`
  }
}

/**
 * What the request tells the sender: that the address is read by a person. A request does it at
 * once. A page alone does it only once the person opens it.
 */
export function whatItTells(target: Target) {
  return target.unsubscribe.method === 'web'
    ? `Opening it tells ${target.sender} that ${target.me} is read by a person.`
    : `This tells ${target.sender} that ${target.me} is read by a person.`
}

/** Why an unsubscribe did not go, in words, for each reason the core gives. */
export const UNSUBSCRIBE_REFUSALS = {
  'unknown-target': 'That message is no longer here, so nothing was sent.',
  'not-supported': 'This message names no way to unsubscribe.',
  'not-permitted': 'This account can’t send mail, so it can’t unsubscribe by email.',
  conflict: 'An unsubscribe from this sender is already on its way.',
  'not-public': 'Its unsubscribe address isn’t on the public internet, so nothing was sent.',
  'refused-by-provider': 'The sender’s server didn’t accept it.',
  unconfirmed: 'It may have gone through. Letterbox won’t retry it on its own.',
  invalid: 'Its unsubscribe address isn’t one Letterbox can use.',
} as const satisfies Record<Refusal, string>

/** The unsubscribe the toast follows, from its confirm until it ends or the toast moves on. */
type Tracked = {
  target: Target
  /** The change the core accepted, or null until it answers. */
  change: ChangeId | null
  /** Why it did not go, once the core says. */
  failed: string | null
  /** The notice the toast showed when this began. A newer one takes the toast. */
  serial: number
  /** True once it has reached where it ends: done, its page, or failed. */
  over: boolean
}

let tracked: Tracked | null = null
let expiry: ReturnType<typeof setTimeout> | undefined
const watchers = new Set<() => void>()

const notify = () => watchers.forEach((watcher) => watcher())

const set = (next: Tracked | null) => {
  tracked = next
  notify()
}

/** How long the toast stays once the unsubscribe has got where it ends. */
const OVER_MS = 8000

/** A sender, by account and address: one unsubscribe at a time goes to each. */
const senderKey = (target: Pick<Target, 'accountId' | 'address'>) =>
  `${target.accountId} ${target.address.toLowerCase()}`

/**
 * The senders whose unsubscribe was confirmed and whose row does not show it yet. Neither the
 * confirm nor ⇧U starts another for them, so no second command goes before the row says where
 * the first has got.
 */
const pending = new Set<string>()

/** True while an unsubscribe from `target`'s sender is confirmed and its row does not show it yet. */
export const usePending = (target: Target) =>
  useSyncExternalStore(
    (onChange) => {
      watchers.add(onChange)
      return () => void watchers.delete(onChange)
    },
    () => pending.has(senderKey(target)),
  )

/**
 * Sends the unsubscribe for `target` and follows it in the toast: the core's refusal, or its
 * row until it settles, and why it failed if it does. With the core lost, nothing is sent. Does
 * nothing while one from the same sender is pending. A `conflict` the core gives anyway leaves
 * the toast on the one it holds.
 */
export async function unsubscribe(target: Target) {
  const key = senderKey(target)
  if (pending.has(key)) return
  clearTimeout(expiry)
  const before = tracked
  const mine: Tracked = { target, change: null, failed: null, serial: noticeSerial(), over: false }
  if (lostReason() !== null) return set({ ...mine, failed: 'Lost the connection, so nothing was sent.', over: true })
  pending.add(key)
  set(mine)
  const sent = commandSettled({ kind: 'unsubscribe', messageId: target.messageId })
  const answer = await sent.answer.catch(() => 'unanswered' as const)
  if (answer === 'unanswered' || answer.kind === 'rejected') pending.delete(key)
  if (tracked !== mine) return
  if (answer === 'unanswered') return end({ failed: 'Lost the connection. It may or may not have gone through.' })
  if (answer.kind === 'rejected') {
    // The one the core already holds from this sender keeps the toast, and its Undo.
    if (answer.reason === 'conflict' && before?.change && senderKey(before.target) === key) return set(before)
    return end({ failed: UNSUBSCRIBE_REFUSALS[answer.reason] })
  }
  set({ ...mine, change: sent.change })
  // The row says how it gets on. Only a failure's reason comes in `settled` alone.
  const result = await sent.settled
  pending.delete(key)
  notify()
  if (tracked?.change !== sent.change) return
  if (result === null) return end({ failed: 'Lost the connection. It may or may not have gone through.' })
  if (typeof result === 'object') end({ failed: UNSUBSCRIBE_REFUSALS[result.failed] })
  if (result === 'undone') stop()
}

/** Marks the followed unsubscribe as over, with why it failed if it did, and lets the toast go a while later. */
function end(with_: Partial<Tracked> = {}) {
  if (!tracked) return
  set({ ...tracked, ...with_, over: true, serial: with_.failed ? noticeSerial() : tracked.serial })
  clearTimeout(expiry)
  const done = tracked
  expiry = setTimeout(() => tracked === done && set(null), OVER_MS)
}

/** Stops following it: the toast goes. */
const stop = () => {
  clearTimeout(expiry)
  set(null)
}

/**
 * The toast's row now shows the followed unsubscribe as `state`. Its sender is no longer
 * pending, Undo follows the core's held state alone, and once it has got where it ends the
 * toast stays a while, then goes.
 */
export const observed = (target: Target, change: ChangeId, state: Unsubscribed['state']) => {
  if (pending.delete(senderKey(target))) notify()
  if (tracked?.change !== change) return
  heldChange = state === 'held' ? change : null
  if ((state === 'done' || state === 'page') && !tracked.over) end()
}

/** The followed unsubscribe's change while the core holds it, the only time Undo is offered. */
let heldChange: ChangeId | null = null

/**
 * Takes back the unsubscribe the core holds as `change` (from a row's `held` state) with the
 * core's `undo`. The toast goes once the core accepts. If the window ended first, the toast says
 * it is on its way.
 */
export async function undoUnsubscribe(change: ChangeId) {
  const answer = await client.command({ kind: 'undo', change }).catch(() => null)
  if (tracked?.change !== change) return
  if (answer?.kind === 'accepted') return stop()
  end({
    failed: answer ? 'Too late to undo. It’s on its way.' : 'Lost the connection. It may or may not have been undone.',
  })
}

/** The followed unsubscribe, while the toast shows it: no newer notice took the toast. */
export function useTracked() {
  const followed = useSyncExternalStore(
    (onChange) => {
      watchers.add(onChange)
      return () => void watchers.delete(onChange)
    },
    () => tracked,
  )
  // A notice newer than it (undo.ts) takes the toast.
  return followed && noticeSerial() <= followed.serial ? followed : null
}

/**
 * The held unsubscribe z and the toast's Undo take back: the followed one, while the toast shows
 * it and its row says the core holds it. Null otherwise, so z goes on to anything else.
 */
export const undoableUnsubscribe = () =>
  tracked && noticeSerial() <= tracked.serial && tracked.change === heldChange ? heldChange : null

/**
 * The Updates row of `address` in `accountId` and `inbox`, live, wherever it sits: a senders
 * view of that one address. Undefined while the core has not answered, and when the sender has
 * no row in Updates.
 */
export function useSenderRow(inbox: MailboxId, accountId: AccountId, address: string) {
  return useView({ view: 'senders', accountId, mailboxId: inbox, address, offset: 0, limit: 1 })?.senders[0]
}

/** Opens a sender's unsubscribe page in the browser, through the shell, or a new tab outside it. */
export function openUnsubscribePage(url: string) {
  if (window.letterbox) return window.letterbox.openPage(url)
  window.open(url, '_blank', 'noopener,noreferrer')
}

/** Where the confirm can open: under the sender's toolbar button, or the conversation's. */
export type ConfirmPlace = 'toolbar' | 'sender'

/**
 * The open confirm: where, and the target it pinned as it opened, so a newer message arriving
 * while it is up changes nothing it sends. `target` is null between a request to open it (⇧U,
 * a row's button) and its button pinning the target it has then.
 */
type Confirming = { place: ConfirmPlace; target: Target | null }

let confirming: Confirming | null = null
const confirmWatchers = new Set<() => void>()

const setConfirm = (next: Confirming | null) => {
  confirming = next
  confirmWatchers.forEach((watcher) => watcher())
}

/** Asks the button at `place` to open its confirm, on the target it has. */
export const requestConfirm = (place: ConfirmPlace) => setConfirm({ place, target: null })

/** Opens the confirm at `place` on `target`, pinned. */
export const openConfirm = (place: ConfirmPlace, target: Target) => setConfirm({ place, target })

/** Closes the confirm. The selection moving on closes it too. */
export const closeConfirm = () => {
  if (confirming) setConfirm(null)
}

/** True while a confirm is open: the reader's shortcuts wait until it closes. */
export const confirmOpen = () => confirming !== null

/** The confirm as it stands at `place`: null when it is shut there. */
export const useConfirming = (place: ConfirmPlace) =>
  useSyncExternalStore(
    (onChange) => {
      confirmWatchers.add(onChange)
      return () => void confirmWatchers.delete(onChange)
    },
    () => (confirming?.place === place ? confirming : null),
  )
