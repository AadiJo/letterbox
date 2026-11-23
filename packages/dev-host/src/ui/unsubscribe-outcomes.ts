// The unsubscribe UI check's second half (unsubscribe.ts runs it), on a core that lets the
// undo window pass, through the real core and the fake web:
//   - Homeware Outlet: the confirm keeps the message it opened on when a newer one arrives. Its
//     signed one-click is posted once, the row and toolbar say "Unsubscribed", z does nothing
//     then, and the toast's Archive all archives every conversation and opens the next sender.
//   - The confirm closes when another sender opens.
//   - Fernhill Garden Club: its signature does not cover List-Unsubscribe-Post, so it goes out as
//     an email, which shows in Sent.
//   - Bramble Books: only its page is left. Nothing opens until the toast's button is clicked.
//   - Quayside Pharmacy and Kestrel Air fail not-public and refused-by-provider, in words, one
//     confirmed while the other waits (unsubscribe-views.ts, with the cases below marked so).
//   - z over Fernhill's done toast, with an archive behind it, sends nothing (views).
//   - A sender unsubscribed while open still says so once its row leaves Updates' window (views).
//   - Every reason the core can refuse one, given by the relay, in words.
//   - A conversation's toolbar: Unsubscribe before Search, its tooltip, ⇧U and Esc.
//   - A sender past the newest 100 in Updates still shows where its unsubscribe has got.

import type { Refusal } from '@letterbox/protocol'
import { devSeeds } from '@letterbox/sim-provider/seeds'
import type { Page } from 'playwright'
import type { RunningSim } from '../sim.ts'
import { equal, type Relay } from './record.ts'
import { open, row } from './reply-page.ts'
import {
  button,
  capture,
  confirm,
  confirmed,
  ME,
  openName,
  openSender,
  rowMark,
  sentOf,
  toast,
  where,
} from './unsubscribe.ts'
import { archiveOpen, at, checkOverlap, checkScrolledOut, checkZOverDone, deliver, lists } from './unsubscribe-views.ts'
import { checkStaggered } from './unsubscribe-races.ts'
import { nav, senderRow } from './updates-edges.ts'

declare global {
  interface Window {
    /** The URLs the page asked a new tab to open, while the check stands in for window.open. */
    openedPages?: string[]
  }
}

const seed = devSeeds.updates

/** Every reason the core can refuse or fail an unsubscribe, in the words the toast uses. */
export const REFUSED: Record<Refusal, string> = {
  'unknown-target': 'That message is no longer here, so nothing was sent.',
  'not-supported': 'This message names no way to unsubscribe.',
  'not-permitted': 'This account can’t send mail, so it can’t unsubscribe by email.',
  conflict: 'An unsubscribe from this sender is already on its way.',
  'not-public': 'Its unsubscribe address isn’t on the public internet, so nothing was sent.',
  'refused-by-provider': 'The sender’s server didn’t accept it.',
  unconfirmed: 'It may have gone through. Letterbox won’t retry it on its own.',
  invalid: 'Its unsubscribe address isn’t one Letterbox can use.',
  'already-unsubscribed': 'You’ve already unsubscribed from Northfield Card.',
}

/** Searches all mail for `text`, so a conversation outside the list's window has a row. */
async function searchFor(page: Page, text: string) {
  await page.getByLabel('Search mail').fill(text)
  await page.getByLabel('Search mail').press('Enter')
}

/** The messageId each unsubscribe the page sent names, in order. */
const unsubscribed = (relay: Relay) =>
  relay
    .fromPage()
    .filter((text) => text.includes('"command":{"kind":"unsubscribe"'))
    .map((text) => (JSON.parse(text) as { command: { messageId: string } }).command.messageId)

/** A pinned confirm, a verified one-click, z once done, and Archive all from the toast. */
async function checkOneClick(page: Page, relay: Relay, running: RunningSim) {
  await openSender(page, 'Homeware Outlet')
  await button(page).click()
  const pinned = await confirm(page).getAttribute('data-message')
  // A newer message from the sender arrives while the confirm is up.
  const first = seed.seed.messages.find((message) => message.key === 'list-homeware-1')
  if (!first) throw new Error('the seed has no Homeware Outlet mail')
  await deliver(page, running, [{ ...first, key: 'list-homeware-5', subject: 'Final call: bedding', sentAt: at(60) }])
  await page.locator('[data-field="open-subject"]', { hasText: 'Final call: bedding' }).waitFor()
  await page.keyboard.press('Enter')
  await toast(page).filter({ hasText: 'Unsubscribed from Homeware Outlet' }).waitFor()
  equal(
    [unsubscribed(relay).at(-1), pinned === null],
    [pinned, false],
    'the confirm unsubscribes with the message it opened on, though a newer one came while it was up',
  )
  const undos = sentOf(relay, 'undo')
  await page.keyboard.press('z')
  equal(
    [
      running.web.posted(),
      await rowMark(page, 'Homeware Outlet').getAttribute('data-state'),
      await where(page).textContent(),
      await page.getByRole('status').getByRole('button').allTextContents(),
      sentOf(relay, 'undo') - undos,
      await page.getByRole('button', { name: 'Archive all 5 conversations' }).count(),
    ],
    [
      [
        {
          url: 'https://homeware.example/unsubscribe/u1',
          type: 'application/x-www-form-urlencoded',
          body: 'List-Unsubscribe=One-Click',
        },
      ],
      'done',
      'Unsubscribed',
      ['Archive all 5'],
      0,
      1,
    ],
    'a signed one-click is posted once, the row and toolbar say Unsubscribed, z sends nothing, and the toast offers Archive all 5',
  )
  await capture(page, 'unsub-done')
  await page.setViewportSize({ width: 640, height: 700 })
  equal(
    await page.getByRole('button', { name: 'Archive all 5 conversations' }).count(),
    1,
    'at 640 px, where it shows its mark and count alone, Archive all keeps its whole name',
  )
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.getByRole('status').getByRole('button', { name: 'Archive all 5' }).click()
  await toast(page).filter({ hasText: 'Archived' }).waitFor()
  await senderRow(page, 'Homeware Outlet').waitFor({ state: 'detached' })
  const next = await openName(page)
  equal(
    [await page.locator('[data-field="toast-note"]').textContent(), next !== null && next !== 'Homeware Outlet'],
    ['Homeware Outlet', true],
    'Archive all archives every conversation, so the row leaves Updates and the next sender opens, as from the toolbar',
  )
}

/** The confirm belongs to the sender it opened on: another sender opening closes it, however it opens. */
async function checkClosesOnSelect(page: Page) {
  await openSender(page, 'Fernhill Garden Club')
  await button(page).click()
  await confirm(page).waitFor()
  // A click alone, with no pointer down outside the confirm first, as assistive tech sends one:
  // the selection moving on is what closes it.
  await senderRow(page, 'Bramble Books').dispatchEvent('click')
  await page.locator('[data-field="open-subject"]', { hasText: 'Five new paperbacks' }).waitFor()
  equal(await confirm(page).count(), 0, 'another sender opening closes the confirm')
}

/**
 * A signature that does not cover List-Unsubscribe-Post: it goes out as an email, which shows in
 * Sent. An archive's notice is behind its toast, for z once it is done (unsubscribe-views.ts).
 */
async function checkMailto(page: Page, relay: Relay, running: RunningSim) {
  const posts = running.web.posted().length
  await archiveOpen(page, 'Huddle')
  await openSender(page, 'Fernhill Garden Club')
  await confirmed(page)
  await toast(page).filter({ hasText: 'Unsubscribed from Fernhill Garden Club' }).waitFor()
  await checkZOverDone(page, relay, 'Huddle')
  await nav(page, 'Sent').click()
  await row(page, 'Unsubscribe').first().waitFor()
  equal(
    [
      running.web.posted().length - posts,
      running.mailbox
        .sent()
        .map((copy) => copy.recipients)
        .filter((to) => to.includes('leave@fernhill.example')),
    ],
    [0, [['leave@fernhill.example']]],
    'a one-click its signature does not vouch for goes out as one email to its address, shown in Sent, and posts nothing',
  )
}

/** Only the page is left: the confirm says opening it tells the sender, and nothing opens until a click. */
async function checkPage(page: Page, running: RunningSim) {
  await page.evaluate(() => {
    window.openedPages = []
    window.open = (url) => {
      window.openedPages?.push(String(url))
      return null
    }
  })
  await openSender(page, 'Bramble Books')
  await button(page).click()
  equal(
    [
      await page.locator('[data-field="unsubscribe-tells"]').textContent(),
      await page.locator('[data-field="unsubscribe-how"]').textContent(),
    ],
    [
      `Opening it tells Bramble Books that ${ME} is read by a person.`,
      'Letterbox can’t ask for you. It keeps the page, so you can open bramblebooks.example when you choose.',
    ],
    'for a page alone, the confirm says Letterbox can’t ask, and that opening the page is what tells the sender',
  )
  await page.keyboard.press('Enter')
  await toast(page).filter({ hasText: 'Bramble Books unsubscribes on its own page' }).waitFor()
  const offered = page.getByRole('status').getByRole('button', { name: /^Open unsubscribe page/ })
  equal(
    [
      await offered.textContent(),
      await page.locator('[data-field="unsubscribe-page"]').count(),
      await rowMark(page, 'Bramble Books').getAttribute('data-state'),
      await page.evaluate(() => window.openedPages),
      running.web.requested().filter((url) => url.includes('bramblebooks')),
    ],
    ['Open unsubscribe page· bramblebooks.example', 1, 'page', [], []],
    'only the page is left: the toast and toolbar offer it, and nothing opens or loads before a click',
  )
  await offered.click()
  equal(
    await page.evaluate(() => window.openedPages),
    ['https://bramblebooks.example/unsubscribe?u=9'],
    'its button opens the page, and only then',
  )
  // The shell refuses the next one, as when pages come too fast: the toolbar's button says so.
  await page.evaluate(() => Reflect.set(window, 'letterbox', { openPage: async () => 'refused-rate' }))
  await page.locator('[data-field="unsubscribe-page"]').click()
  const refused = await page.locator('[data-field="page-refused"]').textContent()
  // The browser does not start: the button says so too.
  await page.evaluate(() => Reflect.set(window, 'letterbox', { openPage: async () => 'failed' }))
  await page.locator('[data-field="unsubscribe-page"]').click()
  await page.locator('[data-field="page-refused"]', { hasText: 'browser' }).waitFor()
  const failed = await page.locator('[data-field="page-refused"]').textContent()
  await page.evaluate(() => Reflect.deleteProperty(window, 'letterbox'))
  equal(
    [refused, failed],
    ['Wait a moment, then try again.', 'Your browser didn’t open it.'],
    'when the shell refuses the page, or the browser does not start, its button says why',
  )
}

/** Every reason the core can refuse one, as the toast says it. The relay gives each, so the core never sees them. */
async function checkRefusals(page: Page, relay: Relay) {
  await openSender(page, 'Northfield Card')
  const said: string[] = []
  for (const reason of Object.keys(REFUSED) as Refusal[]) {
    relay.refuseNextUnsubscribe(reason)
    // oxlint-disable-next-line no-await-in-loop -- one refusal after another, on the one toast
    await confirmed(page)
    // oxlint-disable-next-line no-await-in-loop -- the toast says it once the relay answers
    await toast(page).filter({ hasText: REFUSED[reason] }).waitFor()
    // oxlint-disable-next-line no-await-in-loop -- read once it shows
    said.push((await toast(page).textContent()) ?? '')
  }
  equal(said, Object.values(REFUSED), 'each reason an unsubscribe can be refused or fail for has its own words')
}

/** A conversation's toolbar: Unsubscribe before Search, its tooltip with ⇧U, and the confirm, which Esc closes. */
async function checkConversation(page: Page) {
  await searchFor(page, 'Your card statement')
  await open(page, 'Your card statement')
  await button(page).hover()
  equal(
    await page.getByRole('tooltip').filter({ hasText: 'Unsubscribe from' }).textContent(),
    'Unsubscribe from Northfield CardShift U',
    'in a conversation, Unsubscribe sits before Search, and its tooltip names the sender and ⇧U',
  )
  await capture(page, 'unsub-reader')
  await page.mouse.move(0, 0)
  await page.keyboard.press('Shift+U')
  await confirm(page).waitFor()
  await page.keyboard.press('Escape')
  await confirm(page).waitFor({ state: 'detached' })
  equal(
    await button(page).evaluate((element) => document.activeElement === element),
    true,
    '⇧U opens its confirm, and Esc closes it, focus back on Unsubscribe',
  )
}

/** A sender past the newest 100 in Updates: its conversation's toast still follows its row to the end. */
async function checkFarSender(page: Page, running: RunningSim) {
  // 101 newer senders push The Long Read out of the window.
  await deliver(page, running, lists('newer', 101, 30))
  await searchFor(page, 'Issue 212')
  await open(page, 'Issue 212: the quiet web')
  await confirmed(page)
  await toast(page).filter({ hasText: 'The Long Read unsubscribes on its own page' }).waitFor()
  equal(
    await page.locator('[data-field="unsubscribe-page"]').count(),
    1,
    'a sender past the newest 100 in Updates still shows where its unsubscribe has got, to its page',
  )
}

/** Every outcome, on a core that lets the window pass. */
export async function checkOutcomes(page: Page, relay: Relay, running: RunningSim) {
  await checkOneClick(page, relay, running)
  await checkClosesOnSelect(page)
  await checkMailto(page, relay, running)
  await checkPage(page, running)
  await checkOverlap(page, running)
  await checkStaggered(page, relay, running)
  await checkRefusals(page, relay)
  await checkConversation(page)
  await checkFarSender(page, running)
  await checkScrolledOut(page, running, 'newer list 100')
}
