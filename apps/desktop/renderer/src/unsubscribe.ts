// Unsubscribing from a sender (pick A): the confirm says what it tells the sender and how the
// request goes out, the `unsubscribe` command starts it, and the core holds it for the undo
// window before it carries it out (protocol `Unsubscribed`). The toast follows the sender's
// row: Undo while held, quiet while sending, then "Unsubscribed" with Archive all, or, when only
// the sender's page is left, a button that opens it. Opening it is the person's own click,
// through the shell (ShellBridge.openPage), and never counts as done.
//
// The core's view of one sender, one shared live view per sender (`useSenderRow`), is the only
// source of where an unsubscribe has got, for every control: toolbar, row, conversation, ⇧U,
// the toast and z. The core refuses a second unsubscribe from a sender while one is on its way
// (`conflict`) or once one is done (`already-unsubscribed`), so a view that lags can at worst
// show a refusal. A sender with no row
// in Updates has no control. The renderer keeps only the senders whose unsubscribe is on its
// way until their view shows it, and what the toast says. Undo comes only from the view's `held` state and its change, so it is
// there after a reload too.

import type { Subscription } from '@letterbox/client'
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
import { useEffect, useSyncExternalStore } from 'react'
import type { PageOutcome } from '@letterbox/client/message-port'
import type { Mail } from './actions.ts'
import { client, commandSettled, lostReason } from './core.ts'
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
  'already-unsubscribed': 'You’ve already unsubscribed from this sender.',
} as const satisfies Record<Refusal, string>

/** Why `target`'s unsubscribe did not go, in words, naming the sender where that reads better. */
export const refusalFor = (reason: Refusal, target: Target) =>
  reason === 'already-unsubscribed'
    ? `You’ve already unsubscribed from ${target.sender}.`
    : UNSUBSCRIBE_REFUSALS[reason]

/** A sender, by account and address: the key of everything kept per sender here. */
export const senderKey = (target: Pick<Target, 'accountId' | 'address'>) =>
  `${target.accountId} ${target.address.toLowerCase()}`

/** A sender's Updates row as one inbox has it. */
type SenderRef = Pick<Target, 'accountId' | 'address' | 'inbox'>

/**
 * The live view of one sender's Updates row, shared by everything that reads it: the guard in
 * `unsubscribe`, the toolbar, the row and the toast, so they never disagree. One per sender and
 * inbox, open while anyone watches it. `latest` is undefined until the core answers, and null
 * when the sender has no row in Updates.
 */
type SenderView = {
  subscribe: (onChange: () => void) => () => void
  latest: () => SenderSummary | null | undefined
}

const senderViews = new Map<string, SenderView>()

function senderView(sender: SenderRef): SenderView {
  const key = `${sender.inbox} ${senderKey(sender)}`
  const known = senderViews.get(key)
  if (known) return known
  const { accountId, inbox, address } = sender
  let open: Subscription<'senders'> | undefined
  let users = 0
  const view: SenderView = {
    subscribe: (onChange) => {
      open ??= client.subscribe({ view: 'senders', accountId, mailboxId: inbox, address, offset: 0, limit: 1 })
      const subscription = open
      const stop = subscription.watch(onChange)
      users += 1
      return () => {
        stop()
        users -= 1
        // React unsubscribes and subscribes again at once in Strict Mode. Close only if nobody came back.
        queueMicrotask(() => {
          if (users > 0 || open !== subscription) return
          subscription.close()
          open = undefined
        })
      }
    },
    latest: () => {
      const page = open?.latest()
      return page === undefined ? undefined : (page.senders[0] ?? null)
    },
  }
  senderViews.set(key, view)
  return view
}

/**
 * `sender`'s Updates row, live, from its shared view (`senderView`): the only source of where an
 * unsubscribe from it has got. Undefined until the core answers, and null when the sender has
 * no row in Updates, as for a person's mail or archived automated mail.
 */
export function useSenderRow(sender: SenderRef) {
  const view = senderView(sender)
  return useSyncExternalStore(view.subscribe, view.latest)
}

const watchers = new Set<() => void>()
const notify = () => watchers.forEach((watcher) => watcher())
const subscribe = (onChange: () => void) => {
  watchers.add(onChange)
  return () => void watchers.delete(onChange)
}

/**
 * The senders whose unsubscribe is on its way, with its change: from the confirm until the
 * sender's live view shows that change, or the core refuses or settles it, or ANSWER_MS pass
 * with no word. The core answers `accepted` before its views move on, so the gap between is
 * covered too. This is the only state kept here: past it, the core's view of the sender says
 * the rest.
 */
const inFlight = new Map<string, ChangeId>()

/** How long a sender stays in flight at most. Then its view alone decides, and nothing is sent again. */
const ANSWER_MS = 15_000

/** True while an unsubscribe for `target`'s sender is on its way (`inFlight`). */
export const useInFlight = (target: Target) => useSyncExternalStore(subscribe, () => inFlight.has(senderKey(target)))

/**
 * What the toast shows of one unsubscribe: whose, under which change once the core accepted it,
 * and why it did not go if it did not. Where it has got comes from the sender's view.
 */
export type Shown = {
  target: Target
  change: ChangeId | null
  failed: string | null
  /** The notice the toast showed as this came. A newer one takes the toast. */
  serial: number
}

let shown: Shown | null = null
let expiry: ReturnType<typeof setTimeout> | undefined
/** The change the shown toast's view says the core holds now: the only one z and Undo take back. */
let held: ChangeId | null = null
/** True once the shown toast's view has shown its change. */
let seen = false

/** How long the toast stays once its unsubscribe has got where it ends. */
const OVER_MS = 8000

/** Puts `next` on the toast, and takes it down OVER_MS later when `ends`. */
function show(next: Shown | null, ends = false) {
  clearTimeout(expiry)
  shown = next
  held = null
  seen = false
  notify()
  if (next && ends) expiry = setTimeout(() => shown === next && show(null), OVER_MS)
}

/** Says why `target`'s unsubscribe did not go, on the toast, over whatever it showed. */
const fail = (target: Target, change: ChangeId | null, failed: string) =>
  show({ target, change, failed, serial: noticeSerial() }, true)

/**
 * Sends the unsubscribe for `target`, unless one for its sender is on its way. The toast
 * follows its change from the start. A refusal, or a failure once it settles, says why on the
 * toast, whatever it shows then, except a conflict over a change the toast already follows.
 * With no answer in ANSWER_MS, the sender's view decides: if it shows this change, the toast
 * follows it, else the toast goes. Both waits on the command end then. It never sends again.
 */
export async function unsubscribe(target: Target) {
  const key = senderKey(target)
  if (inFlight.has(key)) return
  if (lostReason() !== null) return fail(target, null, 'Lost the connection, so nothing was sent.')
  const before = shown
  const sent = commandSettled({ kind: 'unsubscribe', messageId: target.messageId })
  inFlight.set(key, sent.change)
  notify()
  const mine: Shown = { target, change: sent.change, failed: null, serial: noticeSerial() }
  show(mine)
  const view = senderView(target)
  const shows = Promise.withResolvers<void>()
  const look = () => {
    if (view.latest()?.unsubscribed?.change === sent.change) shows.resolve()
  }
  const leave = view.subscribe(look)
  look()
  const late = new Promise<'late'>((resolve) => setTimeout(() => resolve('late'), ANSWER_MS))
  // In flight until its view shows it, or the core refuses or settles it, or ANSWER_MS pass.
  void Promise.race([shows.promise, sent.settled, late]).then(() => {
    if (inFlight.get(key) === sent.change) inFlight.delete(key)
    notify()
  })
  try {
    const answer = await Promise.race([sent.answer.catch(() => 'unanswered' as const), late])
    if (answer === 'late') {
      const follows = view.latest()?.unsubscribed?.change === sent.change
      if (!follows && shown === mine) show(null)
      // The view shows it held, or on its way: the toast follows it, unless a newer notice took it.
      if (follows && shown === null && noticeSerial() <= mine.serial) show(mine)
      sent.cancel()
      return
    }
    if (answer === 'unanswered') return fail(target, null, 'Lost the connection. It may or may not have gone through.')
    if (answer.kind === 'rejected') {
      // One from this sender is already on its way: the toast that follows it stays.
      const following = before && !before.failed && before.change && senderKey(before.target) === key
      if (answer.reason === 'conflict' && following) return void (shown === mine && show(before))
      return fail(target, null, refusalFor(answer.reason, target))
    }
    const result = await sent.settled
    if (result === null) {
      if (shown?.change === sent.change)
        fail(target, sent.change, 'Lost the connection. It may or may not have gone through.')
    } else if (typeof result === 'object') fail(target, sent.change, refusalFor(result.failed, target))
    else if (result === 'undone' && shown?.change === sent.change) show(null)
  } finally {
    leave()
  }
}

/**
 * What the shown toast's view says of its unsubscribe: its sender's row, null once the core says
 * the sender has no row in Updates, or undefined before it has answered, which says nothing.
 * Undo follows `held` alone. Once it is done or its page is left, the toast stays a while, then
 * goes. With no row, or once the view has shown it and then loses it, as when its sender's last
 * conversation leaves the inbox, the toast goes at once, and z with it.
 */
export function viewed(change: ChangeId, row: SenderSummary | null | undefined) {
  if (shown?.change !== change || shown.failed || row === undefined) return
  if (row === null) return show(null)
  const state = row.unsubscribed?.change === change ? row.unsubscribed.state : null
  if (state === null) {
    held = null
    if (seen) show(null)
    return
  }
  seen = true
  held = state === 'held' ? change : null
  if (state === 'done' || state === 'page') {
    clearTimeout(expiry)
    const now = shown
    expiry = setTimeout(() => shown === now && show(null), OVER_MS)
  }
}

/** Takes back the unsubscribe the core holds as `change`, from a view's `held` state, with the core's `undo`. */
export async function undoUnsubscribe(change: ChangeId) {
  const answer = await client.command({ kind: 'undo', change }).catch(() => null)
  if (shown?.change !== change) return
  if (answer?.kind === 'accepted') return show(null)
  fail(
    shown.target,
    change,
    answer ? 'Too late to undo. It’s on its way.' : 'Lost the connection. It may or may not have been undone.',
  )
}

/** The toast's unsubscribe, while no newer notice (undo.ts) took the toast. */
export function useShown() {
  const now = useSyncExternalStore(subscribe, () => shown)
  return now && noticeSerial() <= now.serial ? now : null
}

/**
 * z and the toast's Undo, while the toast shows an unsubscribe: they are its, and go no further.
 * Undo goes only when its view says the core holds it, for that change. Otherwise they do
 * nothing. False when the toast shows no unsubscribe, so z goes on to what it shows.
 */
export function undoFromToast() {
  if (!shown || noticeSerial() > shown.serial) return false
  if (held) void undoUnsubscribe(held)
  return true
}

/** Opens a sender's unsubscribe page in the browser, through the shell, or a new tab outside it. */
export async function openUnsubscribePage(url: string): Promise<PageOutcome> {
  if (window.letterbox) return window.letterbox.openPage(url).catch(() => 'refused-url' as const)
  window.open(url, '_blank', 'noopener,noreferrer')
  return 'opened'
}

/** What the page's button says when the shell refused to open it, or the browser did not start. */
export const PAGE_REFUSALS = {
  'refused-rate': 'Wait a moment, then try again.',
  'refused-url': 'This page can’t be opened.',
  failed: 'Your browser didn’t open it.',
} as const satisfies Record<Exclude<PageOutcome, 'opened'>, string>

/** Where the confirm can open: under the sender's toolbar button, or the conversation's. */
export type ConfirmPlace = 'toolbar' | 'sender'

/** The open confirm: where, and the target it pinned as it opened. */
type Confirming = { place: ConfirmPlace; target: Target }

let confirming: Confirming | null = null
/**
 * A request from a row's Unsubscribe to open the confirm of the sender it names once that
 * sender's button is up: by place and sender. Only that sender's button takes it.
 */
let requested: { place: ConfirmPlace; key: string } | null = null
/**
 * The mounted button at each place: its sender, and how it opens its confirm, or null while it
 * cannot start an unsubscribe.
 */
const claims = new Map<ConfirmPlace, { key: string; open: (() => void) | null }>()
const confirmWatchers = new Set<() => void>()

const setConfirm = (next: Confirming | null) => {
  confirming = next
  confirmWatchers.forEach((watcher) => watcher())
}

/** Opens the confirm at `place` on `target`, pinned. */
export const openConfirm = (place: ConfirmPlace, target: Target) => {
  requested = null
  setConfirm({ place, target })
}

/** Closes the confirm, and forgets a request to open one. The selection moving on does it too. */
export const closeConfirm = () => {
  requested = null
  if (confirming) setConfirm(null)
}

/** ⇧U: the button at `place` opens its confirm, if one is up and can start an unsubscribe. Otherwise nothing. */
export const claimConfirm = (place: ConfirmPlace) => claims.get(place)?.open?.()

/**
 * A row's Unsubscribe: the button of `target`'s sender at `place` opens its confirm, at once if
 * it is up, or once it comes up, as when the row opens its sender. If it cannot start one, nothing.
 */
export const requestConfirm = (place: ConfirmPlace, target: Pick<Target, 'accountId' | 'address'>) => {
  const key = senderKey(target)
  const claim = claims.get(place)
  if (claim?.key !== key) {
    requested = { place, key }
    return
  }
  requested = null
  claim.open?.()
}

/** The button at `place` on `target` is up: ⇧U and a request for its sender reach it, and open its confirm while `eligible`. */
function holdClaim(place: ConfirmPlace, target: Target, eligible: boolean) {
  const claim = { key: senderKey(target), open: eligible ? () => openConfirm(place, target) : null }
  claims.set(place, claim)
  if (!eligible && confirming?.place === place) setConfirm(null)
  if (requested?.place === place && requested.key === claim.key) {
    requested = null
    claim.open?.()
  }
  return () => void (claims.get(place) === claim && claims.delete(place))
}

/**
 * For a mounted Unsubscribe at `place` on `target`: while it can start one (`eligible`), ⇧U and
 * a row's request for its sender open its confirm, on its target as it is then. When it can no
 * longer start one, goes, or moves to another sender, its confirm closes.
 */
export function useConfirmClaim(place: ConfirmPlace, target: Target, eligible: boolean) {
  const key = senderKey(target)
  useEffect(() => holdClaim(place, target, eligible), [place, target, eligible])
  useEffect(
    () => () => {
      if (confirming?.place === place) setConfirm(null)
    },
    [place, key],
  )
}

/** True while a confirm is open: the reader's shortcuts, and Search's, wait until it closes. */
export const confirmOpen = () => confirming !== null

/** The confirm open at `place`, or null. */
export const useConfirming = (place: ConfirmPlace) =>
  useSyncExternalStore(
    (onChange) => {
      confirmWatchers.add(onChange)
      return () => void confirmWatchers.delete(onChange)
    },
    () => (confirming?.place === place ? confirming : null),
  )
