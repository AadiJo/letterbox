// Unsubscribing from a sender (pick A): the confirm says what it tells the sender and how the
// request goes out, the `unsubscribe` command starts it, and the core holds it for the undo
// window before it carries it out (protocol `Unsubscribed`). The toast follows the sender's
// row: Undo while held, quiet while sending, then "Unsubscribed" with Archive all, or, when only
// the sender's page is left, a button that opens it. Opening it is the person's own click,
// through the shell (ShellBridge.openPage), and never counts as done.
//
// Only Updates rows carry where an unsubscribe has got, so a conversation reads its sender's
// row from the senders view (`useSenderRow`).

import type {
  AccountId,
  ChangeId,
  MailboxId,
  MessageId,
  Refusal,
  SenderSummary,
  ThreadDetail,
  Unsubscribe,
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
      return `Letterbox can’t ask for you. You open ${hostOf(way.url)} yourself, when you choose.`
  }
}

/** Why an unsubscribe did not go, in words, for each reason the core gives. */
export const UNSUBSCRIBE_REFUSALS = {
  'unknown-target': 'That message is no longer here, so nothing was sent.',
  'not-supported': 'This message names no way to unsubscribe.',
  'not-permitted': 'This account can’t send mail, so it can’t unsubscribe by email.',
  conflict: 'An unsubscribe from this sender is already on its way.',
  'not-public': 'Its unsubscribe address isn’t on the public internet, so nothing was sent.',
  'refused-by-provider': 'The sender’s server didn’t accept it.',
  unconfirmed: 'No answer came. It may have gone through, and it won’t be sent again.',
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

const set = (next: Tracked | null) => {
  tracked = next
  watchers.forEach((watcher) => watcher())
}

/** How long the toast stays once the unsubscribe has got where it ends. */
const OVER_MS = 8000

/**
 * Sends the unsubscribe for `target` and follows it in the toast: the core's refusal, or its
 * row until it settles, and why it failed if it does. With the core lost, nothing is sent.
 */
export async function unsubscribe(target: Target) {
  clearTimeout(expiry)
  const mine: Tracked = { target, change: null, failed: null, serial: noticeSerial(), over: false }
  if (lostReason() !== null) return set({ ...mine, failed: 'Lost the connection, so nothing was sent.', over: true })
  set(mine)
  const sent = commandSettled({ kind: 'unsubscribe', messageId: target.messageId })
  const answer = await sent.answer.catch(() => 'unanswered' as const)
  if (tracked?.target !== target) return
  if (answer === 'unanswered') return end({ failed: 'Lost the connection. It may or may not have gone through.' })
  if (answer.kind === 'rejected') return end({ failed: UNSUBSCRIBE_REFUSALS[answer.reason] })
  set({ ...mine, change: sent.change })
  // The row says how it gets on. Only a failure's reason comes in `settled` alone.
  const result = await sent.settled
  if (tracked?.change !== sent.change) return
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

/** The row has reached where it ends: the toast stays a while, then goes. */
export const reachedEnd = (change: ChangeId) => {
  if (tracked?.change === change && !tracked.over) end()
}

/**
 * Takes the held unsubscribe back with the core's `undo`. The toast goes once the core accepts.
 * If the window ended first, it says it is on its way.
 */
export async function undoUnsubscribe() {
  const change = tracked?.change
  if (!change) return
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

/** True while the toast shows the followed unsubscribe, so z and Undo act on it. */
export const showsUnsubscribe = () => tracked !== null && noticeSerial() <= tracked.serial

/** How many senders a conversation looks through for its sender's row: the newest ones. */
const LOOKUP = 100

/**
 * The Updates row of `address` in `accountId`, live, from the newest senders of `inbox`. A
 * conversation reads where its sender's unsubscribe has got from it. Undefined while the core
 * has not answered, and for a sender past the newest LOOKUP.
 */
export function useSenderRow(inbox: MailboxId, accountId: AccountId, address: string) {
  const page = useView({ view: 'senders', mailboxId: inbox, offset: 0, limit: LOOKUP })
  const wanted = address.toLowerCase()
  return page?.senders.find((row) => row.accountId === accountId && row.address.toLowerCase() === wanted)
}

/** Opens a sender's unsubscribe page in the browser, through the shell, or a new tab outside it. */
export function openUnsubscribePage(url: string) {
  if (window.letterbox) return window.letterbox.openPage(url)
  window.open(url, '_blank', 'noopener,noreferrer')
}

/** Where the open sender's unsubscribe has got, for its toolbar button and row: none when there is none. */
export const stateOf = (row: SenderSummary | undefined) => row?.unsubscribed ?? null

/** The confirm that is open, by where its button is, or null. */
export type ConfirmPlace = 'toolbar' | 'sender'

let confirming: ConfirmPlace | null = null
const confirmWatchers = new Set<() => void>()

/** Opens the confirm under the button at `place`, or closes it with null. */
export const setConfirming = (place: ConfirmPlace | null) => {
  confirming = place
  confirmWatchers.forEach((watcher) => watcher())
}

/** Whether the confirm under the button at `place` is open. */
export const useConfirming = (place: ConfirmPlace) =>
  useSyncExternalStore(
    (onChange) => {
      confirmWatchers.add(onChange)
      return () => void confirmWatchers.delete(onChange)
    },
    () => confirming === place,
  )
