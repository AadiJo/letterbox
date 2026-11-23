// The UI check of unsubscribing (Unsubscribe.tsx, unsubscribe.ts), pick A of the unsubscribe
// mocks, on the `updates` seed's list mail (packages/sim-provider/src/seeds/people-lists.ts),
// through the real core and the fake web. This file runs it, and checks what happens while the
// core holds an unsubscribe, on a core that holds its undo window:
//   - ⇧U where nothing can start one, and a person's mail with a body link (unsubscribe-views.ts).
//   - A row's Unsubscribe on the open sender, a sender opened again, the gap after `accepted`,
//     a sender's last conversation leaving, and no answer at all (unsubscribe-races.ts).
//   - ⇧U opens the confirm, which says what it tells the sender and how it goes out, keeps
//     inside the reader at 640 px, keeps Tab inside it, and holds back the reader's shortcuts.
//     Confirmed, the toast says it is held, with the seconds left and Undo. z takes it back.
//   - While the core has not answered, the sender's Unsubscribe and ⇧U start nothing more.
//   - After a reload, the toolbar still offers Undo for the one the core holds.
//   - The connection ending while it is held ends the toast's wait, saying so.
// unsubscribe-outcomes.ts checks the rest, on a core that lets the window pass. Builds the dev
// host's parts in this process, like attachments.ts. Writes unsub-confirm, unsub-held,
// unsub-done and unsub-reader at twice their pixels, at 1440×900, 1024×700 (-narrow) and
// 640×700 (-640), to compare with unsubscribe.html.

import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { devSeeds } from '@letterbox/sim-provider/seeds'
import type { Browser, Page } from 'playwright'
import { logChildrenTo, stopChildren } from '../children.ts'
import type { Paths } from '../core.ts'
import { startServer } from '../server.ts'
import { startSim } from '../sim.ts'
import { appErrors, ARTIFACTS, equal, openPage, type Relay, root, SIZES } from './record.ts'
import { checkOutcomes } from './unsubscribe-outcomes.ts'
import {
  checkAcceptedGap,
  checkBackToSender,
  checkGoneUnseen,
  checkLastLeaves,
  checkLateAnswer,
  checkNoAnswer,
  checkRowOnOpen,
} from './unsubscribe-races.ts'
import { checkNoClaim, checkPerson } from './unsubscribe-views.ts'
import { senderRow } from './updates-edges.ts'

const seed = devSeeds.updates
const STATE = join(root, '.letterbox/ui-check-unsubscribe')
export const ME = seed.seed.address
export const NARROWEST = { width: 640, height: 700 }

export const button = (page: Page) => page.locator('[data-field="unsubscribe"]')
export const confirm = (page: Page) => page.locator('[data-field="unsubscribe-confirm"]')
export const toast = (page: Page) => page.locator('[data-field="toast"]')
export const where = (page: Page) => page.locator('[data-field="unsubscribe-state"]')
export const rowMark = (page: Page, name: string) => senderRow(page, name).locator('[data-field="row-unsubscribed"]')
/** The name of the sender open in Updates. */
export const openName = (page: Page) =>
  page.locator('[data-sender][aria-selected="true"] [data-field="person"]').textContent()
/** How many messages of `kind` the page sent its cores, in all. */
export const sentOf = (relay: Relay, kind: 'unsubscribe' | 'undo') =>
  relay.fromPage().filter((text) => text.includes(`"command":{"kind":"${kind}"`)).length

/** Takes the page at 1440×900, 1024×700 (-narrow) and 640×700 (-640), and leaves it wide. */
export async function capture(page: Page, name: string) {
  await page.screenshot({ path: join(ARTIFACTS, `${name}.png`), animations: 'disabled' })
  await page.setViewportSize(SIZES.narrow)
  await page.screenshot({ path: join(ARTIFACTS, `${name}-narrow.png`), animations: 'disabled' })
  await page.setViewportSize(NARROWEST)
  await page.screenshot({ path: join(ARTIFACTS, `${name}-640.png`), animations: 'disabled' })
  await page.setViewportSize(SIZES.wide)
}

/** Opens the sender `name` in Updates and waits for its Unsubscribe. */
export async function openSender(page: Page, name: string) {
  await page
    .getByRole('navigation', { name: 'Sidebar' })
    .getByRole('button', { name: /^Updates/ })
    .click()
  await senderRow(page, name).click()
  await button(page).waitFor()
}

/** Confirms an unsubscribe from the open sender with its button and ↵. */
export async function confirmed(page: Page) {
  await button(page).click()
  await confirm(page).waitFor()
  await page.keyboard.press('Enter')
}

/** ⇧U, the confirm's words, its fit, Tab and the held-back shortcuts, then the held toast and z. */
async function checkConfirmAndUndo(page: Page, posted: () => unknown[], sent: () => unknown[]) {
  await openSender(page, 'Homeware Outlet')
  await page.keyboard.press('Shift+U')
  await confirm(page).waitFor()
  equal(
    await confirm(page).evaluate((element) => [
      element.querySelector('h4')?.textContent,
      element.querySelector('[data-field="unsubscribe-tells"]')?.textContent,
      element.querySelector('[data-field="unsubscribe-how"]')?.textContent,
      [...element.querySelectorAll('button')].map((one) => one.textContent),
      Math.round(element.getBoundingClientRect().width),
    ]),
    [
      'Unsubscribe from Homeware Outlet?',
      `This tells Homeware Outlet that ${ME} is read by a person.`,
      `Letterbox asks Homeware Outlet to stop. If it can’t do that directly, it emails them from ${ME}, or gives you their page.`,
      ['CancelEsc', 'Unsubscribe↵'],
      348,
    ],
    '⇧U opens a 348 px confirm: what it tells the sender, how a one-click goes out, Cancel (Esc) and Unsubscribe (↵)',
  )
  await capture(page, 'unsub-confirm')
  // Opened wide, then the window narrowed: the confirm fits the reader again.
  await page.setViewportSize(NARROWEST)
  await page.waitForFunction(() => {
    const box = document.querySelector('[data-field="unsubscribe-confirm"]')?.getBoundingClientRect()
    const reader = document.querySelector('section[aria-label="Reader"]')?.getBoundingClientRect()
    return box && reader && box.left >= reader.left && box.right <= Math.min(reader.right, innerWidth)
  })
  await page.setViewportSize(SIZES.wide)
  // Tab goes round its two buttons, and j, which would open the next sender, and Ctrl+K,
  // which would focus Search, wait.
  await page.keyboard.press('Tab')
  await page.keyboard.press('Tab')
  await page.keyboard.press('Tab')
  await page.keyboard.press('j')
  await page.keyboard.press('Control+k')
  equal(
    [
      await confirm(page).evaluate((element) => element.contains(document.activeElement)),
      await openName(page),
      await confirm(page).isVisible(),
    ],
    [true, 'Homeware Outlet', true],
    'the confirm keeps inside the reader at 640 px, keeps Tab inside it, and holds back the reader’s shortcuts and Search’s',
  )
  await page.keyboard.press('Escape')
  await page.keyboard.press('Shift+U')
  await page.keyboard.press('Enter')
  await toast(page).filter({ hasText: 'Unsubscribing from Homeware Outlet' }).waitFor()
  await rowMark(page, 'Homeware Outlet').waitFor()
  await page.getByRole('status').getByRole('button', { name: /^Undo/ }).waitFor()
  equal(
    [
      /^in \d+ s$/.test((await page.locator('[data-field="toast-note"]').textContent()) ?? ''),
      await rowMark(page, 'Homeware Outlet').getAttribute('data-state'),
      await where(page).getAttribute('data-state'),
    ],
    [true, 'held', 'held'],
    'confirmed, the toast says it is held with the seconds left and Undo, and the row and toolbar say Unsubscribing',
  )
  await capture(page, 'unsub-held')
  await page.keyboard.press('z')
  await rowMark(page, 'Homeware Outlet').waitFor({ state: 'detached' })
  await button(page).waitFor()
  equal(
    [await toast(page).count(), posted(), sent()],
    [0, [], []],
    'z takes the held unsubscribe back: the toast goes, Unsubscribe is back, and nothing was posted or sent',
  )
}

/** While the core has not answered, neither the button nor ⇧U starts a second unsubscribe. */
async function checkOneAtATime(page: Page, relay: Relay) {
  const before = sentOf(relay, 'unsubscribe')
  const paused = relay.pauseAtAccepted()
  await confirmed(page)
  await paused
  await page.keyboard.press('Shift+U')
  equal(
    [await button(page).isDisabled(), await confirm(page).count(), sentOf(relay, 'unsubscribe') - before],
    [true, 0, 1],
    'until the core answers, Unsubscribe is off and ⇧U opens nothing: one unsubscribe goes',
  )
  relay.resume()
  await page.getByRole('status').getByRole('button', { name: /^Undo/ }).waitFor()
  equal(
    await toast(page).textContent(),
    'Unsubscribing from Homeware Outlet',
    'the toast follows the one that went, with its Undo',
  )
}

/** After a reload the toast is gone, and the toolbar's Undo, from the core's held state, takes it back. */
async function checkUndoAfterReload(page: Page, posted: () => unknown[]) {
  await page.reload()
  await page
    .getByRole('navigation', { name: 'Sidebar' })
    .getByRole('button', { name: /^Updates/ })
    .click()
  await senderRow(page, 'Homeware Outlet').click()
  await page.locator('[data-field="unsubscribe-undo"]').waitFor()
  equal(
    [await toast(page).count(), await where(page).getAttribute('data-state')],
    [0, 'held'],
    'after a reload the core still holds it, and the toolbar says so, with Undo',
  )
  await page.locator('[data-field="unsubscribe-undo"]').click()
  await button(page).waitFor()
  equal(posted(), [], 'the toolbar’s Undo takes it back, and nothing was posted')
}

/** The connection ending while one is held ends the toast's wait for it, saying so. */
async function checkDropped(page: Page, relay: Relay) {
  await openSender(page, 'Tidepool List')
  await confirmed(page)
  await page.getByRole('status').getByRole('button', { name: /^Undo/ }).waitFor()
  await relay.drop()
  await toast(page).filter({ hasText: 'Lost the connection' }).waitFor()
  equal(
    await toast(page).textContent(),
    'Lost the connection. It may or may not have gone through.',
    'the connection ending while it is held ends the wait, and the toast says the outcome is unknown',
  )
}

export async function checkUnsubscribe(browser: Browser) {
  rmSync(STATE, { recursive: true, force: true })
  const paths: Paths = {
    root,
    data: join(STATE, 'data'),
    socket: join(STATE, 'provider.sock'),
    coreLog: join(STATE, 'core.log'),
  }
  mkdirSync(paths.data, { recursive: true })
  logChildrenTo(join(STATE, 'host.log'))

  const running = await startSim(paths, seed)
  // The first cores hold the undo window, so Undo can act inside it. The last lets it pass.
  let flags = ['--hold-waits']
  const server = await startServer({ paths, port: 0, relay: true, sim: running.sim, coreFlags: () => flags })
  const opened = await openPage(browser, server.url, 'trace-unsubscribe.zip', { deviceScaleFactor: 2 })
  const { page, relay, errors, remote } = opened
  const posted = () => running.web.posted()
  const sent = () => running.mailbox.sent()
  try {
    await checkNoClaim(page)
    await checkPerson(page)
    await checkRowOnOpen(page)
    await checkBackToSender(page, relay)
    await checkAcceptedGap(page, relay)
    await checkNoAnswer(page, relay)
    await checkConfirmAndUndo(page, posted, sent)
    await checkOneAtATime(page, relay)
    await checkUndoAfterReload(page, posted)
    await checkLastLeaves(page, relay, running)
    await checkGoneUnseen(page, relay, running)
    await checkLateAnswer(page, relay, running)
    await checkDropped(page, relay)
    flags = []
    await page.reload()
    await checkOutcomes(page, relay, running)
    equal(remote, [], 'the page never reached past 127.0.0.1')
    equal(appErrors(errors, { lostCore: true }), [], 'the unsubscribe page logged no errors')
  } finally {
    await opened.close()
    await server.close()
    await running.close()
    await stopChildren()
  }
}
