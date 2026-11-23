// The unsubscribe UI check's cases about where each control reads its state: the core's view
// of the one sender (unsubscribe.ts runs them, some on each core):
//   - ⇧U on a sender with no way to unsubscribe opens nothing, then or once another opens.
//   - A person's mail with an unsubscribe link in its body has no row in Updates, so no control.
//   - Kestrel Air confirmed and waiting at the fake web, then Quayside Pharmacy: each failure
//     says its own words on the toast, in the order they come, and Kestrel's Unsubscribe is back.
//   - z over a done unsubscribe's toast sends nothing, and the archive behind it stays.
//   - A done sender, still open once newer senders push its row out of Updates' window, still
//     says Unsubscribed.

import type { SeedMessage } from '@letterbox/sim-provider/contract'
import { devSeeds } from '@letterbox/sim-provider/seeds'
import type { Page } from 'playwright'
import type { RunningSim } from '../sim.ts'
import { equal, type Relay } from './record.ts'
import { open } from './reply-page.ts'
import { button, confirm, confirmed, ME, openName, openSender, sentOf, toast, where } from './unsubscribe.ts'
import { REFUSED } from './unsubscribe-outcomes.ts'
import { nav, senderRow } from './updates-edges.ts'

declare global {
  interface Window {
    /** Each toast's words in the order they showed, while checkOverlap watches. */
    toastsSeen?: string[]
  }
}

const seed = devSeeds.updates

/** A message `seconds` before the seed's time, as new mail. */
export const at = (seconds: number) => new Date(Date.parse(seed.now) - seconds * 1000).toISOString()

/** Delivers `messages` at the provider, then syncs, so the core has them. */
export async function deliver(page: Page, running: RunningSim, messages: readonly SeedMessage[]) {
  for (const message of messages) running.mailbox.deliver(message)
  await page.evaluate(() => window.letterboxDev?.sync())
}

/**
 * `count` new list senders under `key`, `from` seconds before the seed's time and each a tenth
 * of a second newer, enough to push older senders out of Updates' newest 100. The newest one
 * unsubscribes by email.
 */
export const lists = (key: string, count: number, from: number): SeedMessage[] =>
  Array.from({ length: count }, (_, index) => ({
    key: `list-${key}-${index}`,
    mailboxes: ['inbox'],
    from: { name: `${key} list ${index}`, address: `list${index}@${key}.example` },
    to: [ME],
    subject: `${key} list issue ${index}`,
    text: 'A newer list.',
    sentAt: at(from - index * 0.1),
    headers: {
      listId: true,
      precedence: 'bulk',
      ...(index === count - 1 && { listUnsubscribe: `<mailto:leave@${key}.example>` }),
    },
    bulk: true,
  }))

/** Waits two frames, so effects from the last render have run and painted. */
const settle = (page: Page) =>
  page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))

/** Opens Updates and its sender `name`, without waiting for an Unsubscribe it may not have. */
async function openAny(page: Page, name: string) {
  await nav(page, 'Updates').click()
  await senderRow(page, name).click()
  await page.locator('[data-sender][aria-selected="true"]', { hasText: name }).waitFor()
}

/**
 * ⇧U where no control can start one opens nothing and holds back nothing: j still opens the
 * next sender, and the next sender's Unsubscribe opens no confirm of its own.
 */
export async function checkNoClaim(page: Page) {
  await openAny(page, 'Codeyard')
  await page.keyboard.press('Shift+U')
  await settle(page)
  const there = await confirm(page).count()
  await page.keyboard.press('j')
  await settle(page)
  const next = await openName(page)
  await openSender(page, 'Homeware Outlet')
  await settle(page)
  equal(
    [there, next !== 'Codeyard', await confirm(page).count()],
    [0, true, 0],
    '⇧U on a sender with no way to unsubscribe opens nothing, j still moves on, and the next sender’s Unsubscribe opens no confirm',
  )
}

/** A person's mail with an unsubscribe link in its body: no row in Updates, so no Unsubscribe and no ⇧U. */
export async function checkPerson(page: Page) {
  await page.getByLabel('Search mail').fill('Choir rota')
  await page.getByLabel('Search mail').press('Enter')
  await open(page, 'Choir rota for April')
  await page.getByText('To unsubscribe from rota emails').waitFor()
  // The toolbar asks the core for the sender's row as the conversation opens. A sync goes
  // after that ask, so once it is back the core has answered it.
  await settle(page)
  await page.evaluate(() => window.letterboxDev?.sync())
  await settle(page)
  await page.keyboard.press('Shift+U')
  await settle(page)
  equal(
    [await button(page).count(), await where(page).count(), await confirm(page).count()],
    [0, 0, 0],
    'a person’s mail with an unsubscribe link in its body has no Updates row, so no Unsubscribe, and ⇧U does nothing',
  )
}

/** Kestrel Air's POST, held by the fake web while Quayside Pharmacy is confirmed. */
const KESTREL = 'https://kestrel.example/unsubscribe/7'

/**
 * Confirm A, then B, then A fails: A's failure takes the toast though B's is up, then B's
 * follows, and A can be tried again. The account's queue (crates/core/src/unsubscribe) carries
 * out one at a time, so Quayside waits behind Kestrel's held POST and fails just after it.
 */
export async function checkOverlap(page: Page, running: RunningSim) {
  // Every toast's words as they come, as one may stand for less than a frame.
  await page.evaluate(() => {
    const seen: string[] = []
    window.toastsSeen = seen
    new MutationObserver(() => {
      const now = document.querySelector('[data-field="toast"]')?.textContent ?? null
      if (now !== null && seen.at(-1) !== now) seen.push(now)
    }).observe(document.body, { subtree: true, childList: true, characterData: true })
  })
  const held = running.web.hold(KESTREL)
  await openSender(page, 'Kestrel Air')
  await confirmed(page)
  await held.arrived
  await openSender(page, 'Quayside Pharmacy')
  await confirmed(page)
  await toast(page).filter({ hasText: 'Unsubscribing from Quayside Pharmacy…' }).waitFor()
  held.release()
  await toast(page).filter({ hasText: REFUSED['not-public'] }).waitFor()
  await openSender(page, 'Kestrel Air')
  const failures = new Set([REFUSED['refused-by-provider'], REFUSED['not-public']])
  equal(
    [
      (await page.evaluate(() => window.toastsSeen ?? [])).filter((words) => failures.has(words)),
      await button(page).isEnabled(),
    ],
    [[REFUSED['refused-by-provider'], REFUSED['not-public']], true],
    'Kestrel Air confirmed, then Quayside Pharmacy: Kestrel’s failure takes the toast over Quayside’s, then Quayside’s, and Kestrel’s Unsubscribe is back',
  )
}

/** Archives the open sender's mail from its toolbar, and waits for the toast to say so. */
export async function archiveOpen(page: Page, name: string) {
  await openAny(page, name)
  await page.getByRole('button', { name: /^Archive all \d+ conversations$/ }).click()
  await toast(page).filter({ hasText: 'Archived' }).waitFor()
  await senderRow(page, name).waitFor({ state: 'detached' })
}

/**
 * z while the toast shows a done unsubscribe, with an archive's notice behind it: z is the
 * toast's, and it has no Undo, so nothing is sent and the archive stays.
 */
export async function checkZOverDone(page: Page, relay: Relay, name: string) {
  const undos = sentOf(relay, 'undo')
  await page.keyboard.press('z')
  await settle(page)
  await page.evaluate(() => window.letterboxDev?.sync())
  await nav(page, 'Updates').click()
  await page.locator('[data-sender]').first().waitFor()
  equal(
    [sentOf(relay, 'undo') - undos, await senderRow(page, name).count()],
    [0, 0],
    `z over a done unsubscribe’s toast sends no undo, and the archive of ${name} behind it stays`,
  )
}

/**
 * A sender unsubscribed while it stays open, then pushed out of Updates' window by 101 newer
 * senders: its toolbar still says Unsubscribed, from its own view, not as its row was listed
 * when it opened. `newest` is the last of `lists`, already delivered, the newest sender.
 */
export async function checkScrolledOut(page: Page, running: RunningSim, newest: string) {
  await openSender(page, newest)
  await confirmed(page)
  await toast(page)
    .filter({ hasText: `Unsubscribed from ${newest}` })
    .waitFor()
  await deliver(page, running, lists('pushing', 101, 10))
  await senderRow(page, newest).waitFor({ state: 'detached' })
  await settle(page)
  equal(
    [
      await page.locator('[data-sender][aria-selected="true"]').count(),
      await where(page).getAttribute('data-state'),
      await button(page).count(),
    ],
    [0, 'done', 0],
    `${newest}, unsubscribed while open, then pushed out of Updates’ window, still says Unsubscribed, from its own view`,
  )
}
