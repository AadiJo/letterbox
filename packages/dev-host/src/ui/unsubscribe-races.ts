// The unsubscribe UI check's cases about timing, on the core that holds its undo window
// (unsubscribe.ts runs them), each set up with the relay or the sim so its order is fixed:
//   - A row's Unsubscribe on the sender already open opens its confirm at once.
//   - Back on a sender opened before, its toolbar shows nothing of the last sender's while its
//     newest conversation loads, so ⇧U cannot open the last sender's confirm.
//   - Between the core's `accepted` and its views showing the change, the sender's Unsubscribe
//     and ⇧U send nothing more, and the toast keeps following the first.
//   - A sender whose last conversation leaves the inbox mid-unsubscribe: its view goes empty,
//     and the toast goes, with z.
//   - An unsubscribe nothing answers: after 15 s the sender's view decides again, and nothing
//     is sent twice.
//   - Staggered views: the core settles one while the sender's own view is held. A second is
//     refused already-unsubscribed, and one email goes (this one on the core that lets the
//     window pass).
//   - A sender's view answering with no row before it showed the change: the toast goes.
//   - An answer held past 15 s while the view shows the change held: the toast keeps Undo.

import type { Page } from 'playwright'
import type { RunningSim } from '../sim.ts'
import { equal, type Relay } from './record.ts'
import { button, confirm, confirmed, openSender, sentOf, toast } from './unsubscribe.ts'
import { deliver, lists, settle } from './unsubscribe-views.ts'
import { nav, senderRow } from './updates-edges.ts'

/** The open confirm's title. */
const confirmFor = (page: Page) => confirm(page).getAttribute('aria-label')

/** A row's Unsubscribe, on the sender already open: its confirm opens at once. */
export async function checkRowOnOpen(page: Page) {
  await openSender(page, 'Homeware Outlet')
  await senderRow(page, 'Homeware Outlet').hover()
  await senderRow(page, 'Homeware Outlet').getByRole('button', { name: 'Unsubscribe' }).click()
  await settle(page)
  equal(
    (await confirm(page).count()) > 0 && (await confirmFor(page)),
    'Unsubscribe from Homeware Outlet?',
    'the Unsubscribe on the open sender’s row opens its confirm at once',
  )
  await page.keyboard.press('Escape')
  await confirm(page).waitFor({ state: 'detached' })
}

/** A message from the core that is the live view of one conversation. */
const threadView = (message: string) => message.startsWith('{"kind":"update"') && message.includes('"view":"thread",')

/** Back on a sender opened before, while its newest conversation loads: nothing of the last sender's shows, and ⇧U opens nothing. */
export async function checkBackToSender(page: Page, relay: Relay) {
  await openSender(page, 'Fernhill Garden Club')
  await openSender(page, 'Homeware Outlet')
  // Fernhill's newest conversation stays loading until the relay lets it through.
  const loading = relay.holdFromCore(threadView)
  await senderRow(page, 'Fernhill Garden Club').click()
  await page.locator('[data-sender][aria-selected="true"]', { hasText: 'Fernhill Garden Club' }).waitFor()
  await loading.first
  await settle(page)
  await page.keyboard.press('Shift+U')
  await settle(page)
  const whileLoading = [await button(page).count(), await confirm(page).count()]
  loading.release()
  await button(page).waitFor()
  await page.keyboard.press('Shift+U')
  await confirm(page).waitFor()
  equal(
    [whileLoading, await confirmFor(page)],
    [[0, 0], 'Unsubscribe from Fernhill Garden Club?'],
    'back on Fernhill from Homeware, nothing shows and ⇧U opens nothing until its conversation loads, then its own confirm',
  )
  await page.keyboard.press('Escape')
  await confirm(page).waitFor({ state: 'detached' })
}

/** A message from the core that is a live senders view. */
const sendersView = (message: string) => message.startsWith('{"kind":"update"') && message.includes('"view":"senders",')

/** Between `accepted` and the views moving on, the Unsubscribe and ⇧U send nothing, and the toast stays. */
export async function checkAcceptedGap(page: Page, relay: Relay) {
  await openSender(page, 'Homeware Outlet')
  const before = sentOf(relay, 'unsubscribe')
  const accepted = relay.sees('"kind":"accepted"')
  const views = relay.holdFromCore(sendersView)
  await confirmed(page)
  await accepted
  await views.first
  await settle(page)
  await page.keyboard.press('Shift+U')
  await settle(page)
  if ((await confirm(page).count()) > 0) await page.keyboard.press('Enter')
  await settle(page)
  equal(
    [
      sentOf(relay, 'unsubscribe') - before,
      await button(page).isDisabled(),
      await confirm(page).count(),
      await toast(page).textContent(),
    ],
    [1, true, 0, 'Unsubscribing from Homeware Outlet…'],
    'after the core accepts and before its views show it, Unsubscribe is off, ⇧U sends nothing, and the toast keeps the first',
  )
  views.release()
  await page.getByRole('status').getByRole('button', { name: /^Undo/ }).waitFor()
  await page.keyboard.press('z')
  await button(page).waitFor()
}

/** A sender whose last conversation leaves the inbox mid-unsubscribe: the toast goes, and z with it. */
export async function checkLastLeaves(page: Page, relay: Relay, running: RunningSim) {
  const [only] = lists('gone', 1, 50)
  if (!only) throw new Error('no list to deliver')
  await deliver(page, running, [only])
  await openSender(page, 'gone list 0')
  await confirmed(page)
  await page.getByRole('status').getByRole('button', { name: /^Undo/ }).waitFor()
  running.mailbox.move(only.key, 'home')
  await page.evaluate(() => window.letterboxDev?.sync())
  await senderRow(page, 'gone list 0').waitFor({ state: 'detached' })
  await toast(page).filter({ hasText: 'gone list 0' }).waitFor({ state: 'detached' })
  const undos = sentOf(relay, 'undo')
  await page.keyboard.press('z')
  await settle(page)
  equal(
    [await toast(page).count(), sentOf(relay, 'undo') - undos],
    [0, 0],
    'its last conversation moved out of the inbox, the sender’s view goes empty, so the toast goes, and z undoes nothing',
  )
}

/** An unsubscribe nothing answers: after 15 s its sender's view decides, so Unsubscribe is back, and nothing went twice. */
export async function checkNoAnswer(page: Page, relay: Relay) {
  await openSender(page, 'Bramble Books')
  const before = sentOf(relay, 'unsubscribe')
  relay.swallowNextUnsubscribe()
  await confirmed(page)
  await settle(page)
  const waiting = await button(page).isDisabled()
  await page.waitForFunction(
    () => document.querySelector<HTMLButtonElement>('[data-field="unsubscribe"]')?.disabled === false,
    null,
    { timeout: 25_000 },
  )
  equal(
    [waiting, await toast(page).count(), sentOf(relay, 'unsubscribe') - before],
    [true, 0, 1],
    'with no answer, Unsubscribe waits, then after 15 s it is back and the toast gone, and the one unsubscribe was not sent again',
  )
}

/** A message from the core that updates a live view the page opened of `address` alone: the shared view of one sender. */
const oneSenderUpdate = (relay: Relay, address: string) => (message: string) => {
  const sub = /^\{"kind":"update","sub":"([^"]+)"/.exec(message)?.[1]
  return (
    sub !== undefined &&
    relay.fromPage().some((text) => text.includes(`"sub":"${sub}"`) && text.includes(`"address":"${address}"`))
  )
}

/**
 * Staggered views: the core accepts and settles an unsubscribe, and the Updates list hears it,
 * while the sender's own view is held. The page can ask again, and the core refuses it
 * `already-unsubscribed`: the toast says so, and one email went, not two.
 */
export async function checkStaggered(page: Page, relay: Relay, running: RunningSim) {
  const [only] = lists('race', 1, 40)
  if (!only) throw new Error('no list to deliver')
  await deliver(page, running, [only])
  // The newest sender sits at the top, which the windowed list may have scrolled past.
  await nav(page, 'Updates').click()
  await page.getByRole('listbox', { name: 'Updates' }).evaluate((list) => list.scrollTo({ top: 0 }))
  await openSender(page, 'race list 0')
  const before = sentOf(relay, 'unsubscribe')
  const settledSeen = relay.sees('"kind":"settled"')
  const own = relay.holdFromCore(oneSenderUpdate(relay, 'list0@race.example'))
  await confirmed(page)
  await settledSeen
  await own.first
  await settle(page)
  await button(page).waitFor()
  await page.keyboard.press('Shift+U')
  await confirm(page).waitFor()
  await page.keyboard.press('Enter')
  await toast(page).filter({ hasText: 'already unsubscribed' }).waitFor()
  equal(
    [
      sentOf(relay, 'unsubscribe') - before,
      running.mailbox.sent().filter((copy) => copy.recipients.includes('leave@race.example')).length,
      await toast(page).textContent(),
      relay
        .fromPage()
        .filter((text) => text.includes('"kind":"subscribe"') && text.includes('"address":"list0@race.example"'))
        .length,
    ],
    [2, 1, 'You’ve already unsubscribed from race list 0.', 1],
    'with its own view held after the core settled it, a second unsubscribe is refused already-unsubscribed, one email went, and the row, toolbar, toast and guard shared one view',
  )
  own.release()
  await page.locator('[data-field="unsubscribe-state"][data-state="done"]').waitFor()
}

/**
 * A sender confirmed gone before its view ever showed the change: the view answers with no
 * row, so the toast goes, and z with it. The relay hands over only the newest of the held
 * updates, as a core that sent one update for both changes would.
 */
export async function checkGoneUnseen(page: Page, relay: Relay, running: RunningSim) {
  const [only] = lists('unseen', 1, 45)
  if (!only) throw new Error('no list to deliver')
  await deliver(page, running, [only])
  await openSender(page, 'unseen list 0')
  const accepted = relay.sees('"kind":"accepted"')
  const own = relay.holdFromCore(oneSenderUpdate(relay, 'list0@unseen.example'))
  await confirmed(page)
  await accepted
  await own.first
  running.mailbox.move(only.key, 'home')
  await page.evaluate(() => window.letterboxDev?.sync())
  // The held state's update, then the empty one, both held.
  // oxlint-disable-next-line no-await-in-loop -- waits a frame at a time for the relay to hold the second
  while (own.count() < 2) await settle(page)
  own.releaseLast()
  await toast(page).filter({ hasText: 'unseen list 0' }).waitFor({ state: 'detached' })
  const undos = sentOf(relay, 'undo')
  await page.keyboard.press('z')
  await settle(page)
  equal(
    [await toast(page).count(), sentOf(relay, 'undo') - undos],
    [0, 0],
    'the sender’s view answers with no row before it ever showed the change, so the toast goes, and z undoes nothing',
  )
}

/**
 * The core takes the unsubscribe, but its answer is held past 15 s. The sender's view shows it
 * held, so after the wait the toast still follows it, with Undo. The answer coming later
 * changes nothing: the page no longer waits for it. z then takes it back.
 */
export async function checkLateAnswer(page: Page, relay: Relay, running: RunningSim) {
  const [only] = lists('late', 1, 47)
  if (!only) throw new Error('no list to deliver')
  await deliver(page, running, [only])
  await openSender(page, 'late list 0')
  const answer = relay.holdFromCore((message) => message.startsWith('{"kind":"accepted"'))
  await confirmed(page)
  await answer.first
  await page.getByRole('status').getByRole('button', { name: /^Undo/ }).waitFor()
  // Past the 15 s the page waits for an answer.
  await page.waitForTimeout(16_000)
  const after = [
    await toast(page).textContent(),
    await page.getByRole('status').getByRole('button', { name: /^Undo/ }).count(),
  ]
  answer.release()
  await settle(page)
  const answered = [
    await toast(page).textContent(),
    await page.getByRole('status').getByRole('button', { name: /^Undo/ }).count(),
  ]
  equal(
    [after, answered],
    [
      ['Unsubscribing from late list 0', 1],
      ['Unsubscribing from late list 0', 1],
    ],
    'with its answer held past 15 s, the toast follows the held change from its view, with Undo, and the late answer changes nothing',
  )
  await page.keyboard.press('z')
  await toast(page).filter({ hasText: 'late list 0' }).waitFor({ state: 'detached' })
  await button(page).waitFor()
}
