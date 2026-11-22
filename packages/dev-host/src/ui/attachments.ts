// The UI check of a message's files as rows (Attachments.tsx), on Felix's four files in the
// people-first seed, the mock's scene: type badges are neutral, a row under the pointer lifts,
// a fetch shows "Fetching" over a still 2 px track, a failure says why with Retry where it can
// help, and a program is marked at rest and goes to the shell's own warning with no second
// one in the page. The shell's bridge is stubbed after the page loads (the transport is chosen
// at load, so the page still talks to its core over the WebSocket): each save or open waits
// until the check answers it, newest first, so the check sets the order. The Electron check
// (electron-attachments.ts) drives the real shell. Like rollback.ts, this check builds the dev
// host's parts in this process. Writes attachments-states.png and attachments-risky.png, each
// at 1440×900 and 1024×700 (-narrow).

import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { AttachmentOutcome } from '@letterbox/client/message-port'
import { startSimProvider } from '@letterbox/sim-provider/server'
import type { Browser, Locator, Page } from 'playwright'
import { logChildrenTo, stopChildren } from '../children.ts'
import { buildCore, type Paths } from '../core.ts'
import { startServer } from '../server.ts'
import { appErrors, ARTIFACTS, equal, openPage, root, SIZES } from './record.ts'
import { ME, open, seed, yourTurn } from './reply-page.ts'

declare global {
  interface Window {
    /** The UI check's stand-in for the shell's attachment calls: what was asked, and a way to answer the newest. */
    fileStub?: { asked: string[]; answer(outcome: AttachmentOutcome): void }
  }
}

const STATE = join(root, '.letterbox/ui-check-attachments')
const PHOTO = 'lake-jetty-1998.jpg'
const ZIP = 'reunion-scans-roll-2.zip'
const SHEET = 'contact-sheet.pdf'
const PROGRAM = 'RawViewer-setup.exe'

const row = (page: Page, name: string) =>
  page.locator('[data-field="attachment"]').filter({ has: page.locator('[data-field="name"]', { hasText: name }) })
const button = (page: Page, action: 'Open' | 'Save' | 'Retry', name: string) =>
  page.getByRole('button', { name: `${action} ${name}`, exact: true })

/** Answers the newest save or open still waiting, and waits for its row to leave the fetching state. */
async function answer(page: Page, name: string, outcome: AttachmentOutcome) {
  await page.evaluate((given) => window.fileStub?.answer(given), outcome)
  await row(page, name).and(page.locator(':not([data-state="fetching"])')).waitFor()
}

/** The calls the shell was asked for, oldest first. */
const asked = (page: Page) => page.evaluate(() => window.fileStub?.asked ?? [])

/** A row's colors and the part that shows on its right. */
const looks = (found: Locator) =>
  found.evaluate((element) => {
    const css = (selector: string) => {
      const part = element.querySelector(selector)
      return part ? { color: getComputedStyle(part).color, background: getComputedStyle(part).backgroundColor } : null
    }
    return {
      row: getComputedStyle(element).backgroundColor,
      name: css('[data-field="name"]')?.color,
      open: css('button[aria-label^="Open "]'),
      save: css('button[aria-label^="Save "]'),
    }
  })

/** Takes the scene at 1440×900 and 1024×700, with the pointer on `hover` each time. */
async function captureWith(page: Page, scene: string, hover: Locator) {
  const shot = async (size: (typeof SIZES)[keyof typeof SIZES], file: string) => {
    await page.setViewportSize(size)
    await hover.scrollIntoViewIfNeeded()
    await hover.hover()
    await page.screenshot({ path: join(ARTIFACTS, file), animations: 'disabled' })
  }
  await shot(SIZES.wide, `${scene}.png`)
  await shot(SIZES.narrow, `${scene}-narrow.png`)
  await page.setViewportSize(SIZES.wide)
}

const WASH = 'rgba(255, 255, 255, 0.04)'
const PILL = 'rgba(255, 255, 255, 0.08)'
const CLEAR = 'rgba(0, 0, 0, 0)'
const FG = 'rgb(245, 245, 245)'
const FG2 = 'rgb(210, 210, 210)'
const MUTED = 'rgb(163, 163, 163)'
const RED = 'rgb(255, 106, 99)'

async function checkRows(page: Page) {
  // At rest: one card of 48 px rows, at most 640 px wide, badges neutral, and only the program marked.
  const rows = page.locator('[data-message="open"] [data-field="attachment"]')
  equal(
    await rows.evaluateAll((found) =>
      found.map((element) => {
        const badge = element.querySelector('[data-field="type"]')
        return {
          height: element.getBoundingClientRect().height,
          badge: badge && [
            badge.textContent,
            badge.getBoundingClientRect().width,
            getComputedStyle(badge).backgroundColor,
            getComputedStyle(badge).color,
          ],
          program: element.querySelector('[data-field="program"]') !== null,
        }
      }),
    ),
    [
      { height: 48, badge: ['JPG', 34, PILL, FG2], program: false },
      { height: 48, badge: ['ZIP', 34, PILL, FG2], program: false },
      { height: 48, badge: ['PDF', 34, PILL, FG2], program: false },
      { height: 48, badge: ['EXE', 34, PILL, FG2], program: true },
    ],
    'each file is a 48 px row with a neutral 34 px type badge, and only the program is marked at rest',
  )
  const card = await page.locator('[data-message="open"] ul:has([data-field="attachment"])').boundingBox()
  equal(card?.width, 640, 'the rows sit in one card, 640 px wide at most')
  equal(
    await looks(row(page, PHOTO)),
    { row: CLEAR, name: FG2, open: { color: MUTED, background: CLEAR }, save: { color: MUTED, background: CLEAR } },
    'at rest a row is flat, its name secondary, Open and Save muted',
  )

  // Hover: the row lifts, its name brightens, and the button under the pointer fills.
  await button(page, 'Open', PHOTO).hover()
  equal(
    await looks(row(page, PHOTO)),
    { row: WASH, name: FG, open: { color: FG, background: PILL }, save: { color: FG2, background: CLEAR } },
    'under the pointer the row lifts, its name brightens, and the hovered button fills',
  )

  // Fetching: the size moves into "Fetching", over a 2 px track that does not move by itself.
  await button(page, 'Save', ZIP).click()
  const zip = row(page, ZIP)
  await zip.locator('[data-field="fetching"]').waitFor()
  equal(
    await zip.evaluate((element) => {
      const track = element.querySelector('[data-field="fetch-track"]')
      const box = element.getBoundingClientRect()
      const bar = track?.getBoundingClientRect()
      return {
        says: element.querySelector('[data-field="fetching"]')?.textContent,
        size: element.querySelector('[data-field="size"]') !== null,
        track: bar && { height: bar.height, onFoot: bar.bottom === box.bottom, fill: track?.childElementCount },
        moving: document.getAnimations().filter((animation) => {
          const target = animation.effect instanceof KeyframeEffect ? animation.effect.target : null
          return target instanceof Node && element.contains(target)
        }).length,
      }
    }),
    { says: 'Fetching · 48.6 MB', size: false, track: { height: 2, onFoot: true, fill: 0 }, moving: 0 },
    'a fetch says "Fetching · 48.6 MB" over a still 2 px track on the row\'s foot, with no fill to fake progress',
  )

  // Failed: why, in red, and Retry.
  await button(page, 'Open', SHEET).click()
  await answer(page, SHEET, { ok: false, reason: 'offline' })
  const sheet = row(page, SHEET)
  equal(
    [
      await sheet.locator('[data-field="failed"]').textContent(),
      await sheet.locator('[data-field="failed"]').evaluate((element) => getComputedStyle(element).color),
      await button(page, 'Retry', SHEET).count(),
    ],
    ["Couldn't fetch while offline", RED, 1],
    'a fetch that failed offline says so in red, with Retry',
  )
  await captureWith(page, 'attachments-states', button(page, 'Open', PHOTO))
  // The mock's risky scene is the same rows, with the pointer on the program's Open.
  await captureWith(page, 'attachments-risky', button(page, 'Open', PROGRAM))

  await button(page, 'Retry', SHEET).click()
  await answer(page, SHEET, { ok: true })
  equal(
    [(await asked(page)).slice(-2), await sheet.getAttribute('data-state')],
    [['open', 'open'], 'rest'],
    'Retry asks the shell again for the same thing, and a file that opens leaves the row at rest',
  )

  // The other reasons: one says why and offers no Retry, and a closed dialog says nothing.
  await button(page, 'Save', PHOTO).click()
  await answer(page, PHOTO, { ok: false, reason: 'gone' })
  equal(
    [await row(page, PHOTO).locator('[data-field="failed"]').textContent(), await button(page, 'Retry', PHOTO).count()],
    ['No longer on the server', 0],
    'a file the server no longer has says so, with no Retry',
  )
  await button(page, 'Save', SHEET).click()
  await answer(page, SHEET, { ok: false, reason: 'cancelled' })
  equal(await sheet.getAttribute('data-state'), 'rest', 'a closed save dialog leaves the row at rest, saying nothing')
}

/** The program: marked at rest, and Open goes to the shell once, with no warning of the page's own. */
async function checkProgram(page: Page) {
  const before = (await asked(page)).length
  await button(page, 'Open', PROGRAM).click()
  await row(page, PROGRAM).locator('[data-field="fetching"]').waitFor()
  equal(
    [
      (await asked(page)).slice(before),
      await page.locator('section[aria-label="Reader"]').getByRole('alertdialog').count(),
      await page.locator('section[aria-label="Reader"]').getByRole('dialog').count(),
    ],
    [['open'], 0, 0],
    'Open on a program asks the shell once, whose warning is the only one: the page shows none of its own',
  )
  await answer(page, PROGRAM, { ok: false, reason: 'declined' })
  equal(
    await row(page, PROGRAM).getAttribute('data-state'),
    'rest',
    "declining the shell's warning leaves the row at rest, saying nothing",
  )
}

export async function checkAttachments(browser: Browser) {
  rmSync(STATE, { recursive: true, force: true })
  const paths: Paths = {
    root,
    data: join(STATE, 'data'),
    socket: join(STATE, 'provider.sock'),
    coreLog: join(STATE, 'core.log'),
  }
  mkdirSync(paths.data, { recursive: true })
  logChildrenTo(join(STATE, 'host.log'))

  await buildCore(paths)
  const provider = await startSimProvider(paths.socket)
  provider.createMailbox(seed.dialect, seed.seed)
  const server = await startServer({ paths, port: 0, relay: true, sim: { now: seed.now, deliver: () => {} } })
  const opened = await openPage(browser, server.url, 'trace-attachments.zip')
  const { page, errors } = opened
  try {
    await page.waitForFunction(() => window.letterboxDev !== undefined)
    await page.evaluate(([address, password]) => window.letterboxDev?.signIn(address, password), [
      ME,
      seed.seed.password,
    ] as const)
    await yourTurn(page).first().waitFor()
    await page.evaluate(() => {
      const calls: string[] = []
      const waiting: ((outcome: AttachmentOutcome) => void)[] = []
      const ask = (action: string) => () =>
        new Promise<AttachmentOutcome>((resolve) => {
          calls.push(action)
          waiting.push(resolve)
        })
      window.letterbox = {
        platform: 'linux',
        connect: () => {},
        openAttachment: ask('open'),
        saveAttachment: ask('save'),
        onOpenConversation: () => () => {},
      }
      window.fileStub = { asked: calls, answer: (outcome) => waiting.pop()?.(outcome) }
    })
    await open(page, 'Photos from the reunion')
    await row(page, PROGRAM).waitFor()
    await checkRows(page)
    await checkProgram(page)
    await answer(page, ZIP, { ok: true })
    equal(appErrors(errors), [], 'the attachments page logged no errors')
  } finally {
    await opened.close()
    await server.close()
    await provider.close()
    await stopChildren()
  }
}
