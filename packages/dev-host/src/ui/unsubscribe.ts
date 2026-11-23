// The UI check of unsubscribing (Unsubscribe.tsx, unsubscribe.ts), pick A of the unsubscribe
// mocks, on the `updates` seed's list mail (packages/sim-provider/src/seeds/people-lists.ts),
// through the real core and the fake web:
//   - Homeware Outlet, with the undo window held: ⇧U opens the confirm, which says what it tells
//     the sender and how it goes out. Confirmed, the toast says it is held, with the seconds left
//     and Undo, and the row and toolbar say "Unsubscribing". z takes it back, and nothing was
//     posted or sent.
//   - Homeware Outlet again, on a core that lets the window pass: its signed one-click is posted
//     once, the row and toolbar say "Unsubscribed", and the toast's Archive all archives its 4.
//   - Fernhill Garden Club: its signature does not cover List-Unsubscribe-Post, so it goes out as
//     an email, which shows in Sent.
//   - Bramble Books: only its page is left. Nothing opens until the toast's button is clicked.
//   - Quayside Pharmacy and Kestrel Air fail not-public and refused-by-provider, in words.
//   - Every reason the core can refuse one, given by the relay, in words.
//   - A conversation's toolbar: Unsubscribe before Search, its tooltip, ⇧U and Esc.
// Builds the dev host's parts in this process, like attachments.ts. Writes unsub-confirm,
// unsub-held, unsub-done and unsub-reader at twice their pixels, at 1440×900, 1024×700
// (-narrow) and 640×700 (-640), to compare with unsubscribe.html.

import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { Refusal } from '@letterbox/protocol'
import { devSeeds } from '@letterbox/sim-provider/seeds'
import type { Browser, Page } from 'playwright'
import { logChildrenTo, stopChildren } from '../children.ts'
import type { Paths } from '../core.ts'
import { startServer } from '../server.ts'
import { startSim } from '../sim.ts'
import { appErrors, ARTIFACTS, equal, openPage, type Relay, root, SIZES } from './record.ts'
import { open, row } from './reply-page.ts'
import { nav, senderRow } from './updates-edges.ts'

declare global {
  interface Window {
    /** The URLs the page asked a new tab to open, while the check stands in for window.open. */
    openedPages?: string[]
  }
}

const seed = devSeeds.updates
const STATE = join(root, '.letterbox/ui-check-unsubscribe')
const ME = seed.seed.address
const NARROWEST = { width: 640, height: 700 }

const button = (page: Page) => page.locator('[data-field="unsubscribe"]')
const confirm = (page: Page) => page.locator('[data-field="unsubscribe-confirm"]')
const toast = (page: Page) => page.locator('[data-field="toast"]')
const where = (page: Page) => page.locator('[data-field="unsubscribe-state"]')
const rowMark = (page: Page, name: string) => senderRow(page, name).locator('[data-field="row-unsubscribed"]')

/** Every reason the core can refuse or fail an unsubscribe, in the words the toast uses. */
const REFUSED: Record<Refusal, string> = {
  'unknown-target': 'That message is no longer here, so nothing was sent.',
  'not-supported': 'This message names no way to unsubscribe.',
  'not-permitted': 'This account can’t send mail, so it can’t unsubscribe by email.',
  conflict: 'An unsubscribe from this sender is already on its way.',
  'not-public': 'Its unsubscribe address isn’t on the public internet, so nothing was sent.',
  'refused-by-provider': 'The sender’s server didn’t accept it.',
  unconfirmed: 'No answer came. It may have gone through, and it won’t be sent again.',
  invalid: 'Its unsubscribe address isn’t one Letterbox can use.',
}

/** Takes the page at 1440×900, 1024×700 (-narrow) and 640×700 (-640), and leaves it wide. */
async function capture(page: Page, name: string) {
  await page.screenshot({ path: join(ARTIFACTS, `${name}.png`), animations: 'disabled' })
  await page.setViewportSize(SIZES.narrow)
  await page.screenshot({ path: join(ARTIFACTS, `${name}-narrow.png`), animations: 'disabled' })
  await page.setViewportSize(NARROWEST)
  await page.screenshot({ path: join(ARTIFACTS, `${name}-640.png`), animations: 'disabled' })
  await page.setViewportSize(SIZES.wide)
}

/** Opens the sender `name` in Updates and waits for its Unsubscribe. */
async function openSender(page: Page, name: string) {
  await nav(page, 'Updates').click()
  await senderRow(page, name).click()
  await button(page).waitFor()
}

/** Confirms an unsubscribe from the open sender with its button and ↵. */
async function confirmed(page: Page) {
  await button(page).click()
  await confirm(page).waitFor()
  await page.keyboard.press('Enter')
}

/** With the undo window held: ⇧U, the confirm, the held toast, and z. Nothing goes out. */
async function checkHeldThenUndone(page: Page, posted: () => unknown[], sent: () => unknown[]) {
  await openSender(page, 'Homeware Outlet')
  await page.keyboard.press('Shift+U')
  await confirm(page).waitFor()
  equal(
    await confirm(page).evaluate((element) => [
      element.querySelector('h4')?.textContent,
      element.querySelector('p')?.textContent,
      element.querySelector('[data-field="unsubscribe-how"]')?.textContent,
      [...element.querySelectorAll('button')].map((one) => one.textContent),
      Math.round(element.getBoundingClientRect().width),
    ]),
    [
      'Unsubscribe from Homeware Outlet?',
      `This tells Homeware Outlet that ${ME} is read by a person. Most senders stop within a few days.`,
      `Letterbox asks Homeware Outlet to stop. If it can’t do that directly, it emails them from ${ME}, or gives you their page.`,
      ['CancelEsc', 'Unsubscribe↵'],
      348,
    ],
    '⇧U opens a 348 px confirm: what it tells the sender, how it goes out for a one-click, Cancel (Esc) and Unsubscribe (↵)',
  )
  await capture(page, 'unsub-confirm')
  // Opened wide, then the window narrowed: the confirm fits the reader again.
  await page.setViewportSize(NARROWEST)
  await page.waitForFunction(() => {
    const box = document.querySelector('[data-field="unsubscribe-confirm"]')?.getBoundingClientRect()
    const reader = document.querySelector('section[aria-label="Reader"]')?.getBoundingClientRect()
    return box && reader && box.left >= reader.left && box.right <= Math.min(reader.right, innerWidth)
  })
  equal(
    await confirm(page).isVisible(),
    true,
    'opened wide and the window narrowed to 640 px, the confirm keeps inside the reader',
  )
  await page.setViewportSize(SIZES.wide)
  await page.keyboard.press('Enter')
  await toast(page).filter({ hasText: 'Unsubscribing from Homeware Outlet' }).waitFor()
  await rowMark(page, 'Homeware Outlet').waitFor()
  equal(
    [
      /^in \d+ s$/.test((await page.locator('[data-field="toast-note"]').textContent()) ?? ''),
      await page.getByRole('status').getByRole('button', { name: /^Undo/ }).count(),
      await rowMark(page, 'Homeware Outlet').getAttribute('data-state'),
      await where(page).getAttribute('data-state'),
    ],
    [true, 1, 'held', 'held'],
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

/** A verified one-click: one POST, Unsubscribed on the row and the toolbar, and Archive all. */
async function checkOneClick(page: Page, posted: () => unknown[]) {
  await openSender(page, 'Homeware Outlet')
  await confirmed(page)
  await toast(page).filter({ hasText: 'Unsubscribed from Homeware Outlet' }).waitFor()
  equal(
    [
      posted(),
      await rowMark(page, 'Homeware Outlet').getAttribute('data-state'),
      await where(page).textContent(),
      await page.getByRole('status').getByRole('button').allTextContents(),
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
      ['Archive all 4'],
    ],
    'a signed one-click is posted once, the row and toolbar say Unsubscribed, and the toast offers Archive all 4',
  )
  await capture(page, 'unsub-done')
  await page.getByRole('status').getByRole('button', { name: 'Archive all 4' }).click()
  await toast(page).filter({ hasText: 'Archived' }).waitFor()
  await senderRow(page, 'Homeware Outlet').waitFor({ state: 'detached' })
  equal(
    await page.locator('[data-field="toast-note"]').textContent(),
    'Homeware Outlet',
    'Archive all archives every one of its conversations, so its row leaves Updates',
  )
}

/** A signature that does not cover List-Unsubscribe-Post: it goes out as an email, which shows in Sent. */
async function checkMailto(page: Page, posted: () => unknown[], sent: () => { recipients: string[] }[]) {
  await openSender(page, 'Fernhill Garden Club')
  await confirmed(page)
  await toast(page).filter({ hasText: 'Unsubscribed from Fernhill Garden Club' }).waitFor()
  await nav(page, 'Sent').click()
  await row(page, 'Unsubscribe').first().waitFor()
  equal(
    [posted().length, sent().map((copy) => copy.recipients)],
    [1, [['leave@fernhill.example']]],
    'a one-click its signature does not vouch for goes out as one email to its address, shown in Sent, and posts nothing',
  )
}

/** Only the page is left: nothing opens until the toast's button is clicked. */
async function checkPage(page: Page, requested: () => string[]) {
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
    await page.locator('[data-field="unsubscribe-how"]').textContent(),
    'Letterbox can’t ask for you. You open bramblebooks.example yourself, when you choose.',
    'for a page alone, the confirm says Letterbox can’t ask, and the person opens it',
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
      requested().filter((url) => url.includes('bramblebooks')),
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
}

/** A one-click that fails once out of its window, in words. */
async function checkFailed(page: Page, name: string, reason: Refusal) {
  await openSender(page, name)
  await confirmed(page)
  await toast(page).filter({ hasText: REFUSED[reason] }).waitFor()
  await button(page).waitFor()
  equal(
    await toast(page).textContent(),
    REFUSED[reason],
    `${name}'s unsubscribe fails ${reason}, in words, and Unsubscribe is back`,
  )
}

/** Every reason the core can refuse one, as the toast says it. The relay gives each, so the core never sees them. */
async function checkRefusals(page: Page, relay: Relay) {
  await openSender(page, 'Tidepool List')
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
  await nav(page, 'All mail').click()
  await open(page, 'The long thread')
  await button(page).hover()
  equal(
    await page.getByRole('tooltip').filter({ hasText: 'Unsubscribe from' }).textContent(),
    'Unsubscribe from Tidepool ListShift U',
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
  // The first core holds the undo window, so Undo can act inside it. The next lets it pass.
  let flags = ['--hold-waits']
  const server = await startServer({ paths, port: 0, relay: true, sim: running.sim, coreFlags: () => flags })
  const opened = await openPage(browser, server.url, 'trace-unsubscribe.zip', { deviceScaleFactor: 2 })
  const { page, relay, errors, remote } = opened
  const posted = () => running.web.posted()
  const sent = () => running.mailbox.sent()
  try {
    await checkHeldThenUndone(page, posted, sent)
    flags = []
    await page.reload()
    await checkOneClick(page, posted)
    await checkMailto(page, posted, sent)
    await checkPage(page, running.web.requested)
    await checkFailed(page, 'Quayside Pharmacy', 'not-public')
    await checkFailed(page, 'Kestrel Air', 'refused-by-provider')
    await checkRefusals(page, relay)
    await checkConversation(page)
    equal(remote, [], 'the page never reached past 127.0.0.1')
    equal(appErrors(errors), [], 'the unsubscribe page logged no errors')
  } finally {
    await opened.close()
    await server.close()
    await running.close()
    await stopChildren()
  }
}
