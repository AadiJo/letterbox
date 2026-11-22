// The UI check of a message's files as rows (Attachments.tsx), on Felix's four files in the
// people-first seed, the mock's scene: type badges are neutral, a row under the pointer lifts,
// a fetch says "Fetching" with nothing on the row that pretends to move, a failure says what
// went wrong in red and why in a quieter color, with Retry where it can help, a fetch keeps
// its state when the conversation closes and opens again and is never asked twice, a narrow
// card wraps a row's status under its name, and a program is marked at rest and goes to the
// shell's own warning with no second one in the page.
//
// The shell's bridge is stubbed after the page loads (the transport is chosen at load, so the
// page still talks to its core over the WebSocket). Each save or open waits until the check
// answers that action for that file, so the check sets the order. The Electron check
// (electron-attachments.ts) drives the real shell. Like rollback.ts, this check builds the dev
// host's parts in this process. Writes attachments-states.png, attachments-risky.png and
// attachments-640.png at twice their pixels: the first two at 1440×900 and 1024×700 (-narrow),
// the last at 640×700, the narrowest window.

import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { AttachmentOutcome } from '@letterbox/client/message-port'
import type { BlobId } from '@letterbox/protocol'
import { startSimProvider } from '@letterbox/sim-provider/server'
import type { Browser, Locator, Page } from 'playwright'
import { logChildrenTo, stopChildren } from '../children.ts'
import { buildCore, type Paths } from '../core.ts'
import { startServer } from '../server.ts'
import { appErrors, ARTIFACTS, equal, openPage, root, SIZES } from './record.ts'
import { ME, open, seed, yourTurn } from './reply-page.ts'

type Call = { action: 'open' | 'save'; blobId: string }

declare global {
  interface Window {
    /** The UI check's stand-in for the shell's attachment calls: each one asked, and a way to answer one. */
    fileStub?: { asked: Call[]; answer(call: Call, outcome: AttachmentOutcome): boolean }
  }
}

const STATE = join(root, '.letterbox/ui-check-attachments')
const SUBJECT = 'Photos from the reunion'
const PHOTO = 'lake-jetty-1998.jpg'
const ZIP = 'reunion-scans-roll-2.zip'
const SHEET = 'contact-sheet.pdf'
const PROGRAM = 'RawViewer-setup.exe'
const NARROWEST = { width: 640, height: 700 }

const row = (page: Page, name: string) =>
  page.locator('[data-field="attachment"]').filter({ has: page.locator('[data-field="name"]', { hasText: name }) })
const button = (page: Page, action: 'Open' | 'Save' | 'Retry', name: string) =>
  page.getByRole('button', { name: `${action} ${name}`, exact: true })

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

/** What a failed row says: what went wrong and its color, why and its color, and whether it offers Retry. */
const failedRow = (found: Locator) =>
  found.evaluate((element) => {
    const failed = element.querySelector('[data-field="failed"]')
    const [says, why] = [...(failed?.querySelectorAll(':scope > span') ?? [])]
    return {
      text: failed?.textContent ?? null,
      says: says && [says.textContent, getComputedStyle(says).color],
      why: why ? [why.textContent, getComputedStyle(why).color] : null,
      retry: element.querySelector('button[aria-label^="Retry "]') !== null,
    }
  })

const WASH = 'rgba(255, 255, 255, 0.04)'
const PILL = 'rgba(255, 255, 255, 0.08)'
const CLEAR = 'rgba(0, 0, 0, 0)'
const FG = 'rgb(245, 245, 245)'
const FG2 = 'rgb(210, 210, 210)'
const MUTED = 'rgb(163, 163, 163)'
const RED = 'rgb(255, 106, 99)'

/** The check's view of Felix's message: answering a file's calls, and capturing the scene. */
function scene(page: Page, ids: ReadonlyMap<string, BlobId>) {
  const idOf = (name: string) => {
    const id = ids.get(name)
    if (!id) throw new Error(`Felix's message has no file called ${name}`)
    return id
  }
  return {
    idOf,
    /** Answers the waiting `action` for the file `name`, and waits for its row to leave the fetching state. */
    answer: async (name: string, action: Call['action'], outcome: AttachmentOutcome) => {
      const call = { action, blobId: idOf(name) }
      const answered = await page.evaluate(([given, result]) => window.fileStub?.answer(given, result), [
        call,
        outcome,
      ] as const)
      if (!answered) throw new Error(`no ${action} of ${name} was waiting`)
      await row(page, name).and(page.locator(':not([data-state="fetching"])')).waitFor()
    },
    /**
     * Takes the scene at 1440×900 and 1024×700, with the pointer on `hover`. The narrow one
     * scrolls the conversation to its end first, so the reply bar shows whole.
     */
    capture: async (name: string, hover: Locator) => {
      const shot = async (size: (typeof SIZES)[keyof typeof SIZES], file: string, toEnd: boolean) => {
        await page.setViewportSize(size)
        if (toEnd)
          await page.locator('[data-scroll]').evaluate((element) => element.scrollTo({ top: element.scrollHeight }))
        await hover.scrollIntoViewIfNeeded()
        await hover.hover()
        await page.screenshot({ path: join(ARTIFACTS, file), animations: 'disabled' })
      }
      await shot(SIZES.wide, `${name}.png`, false)
      await shot(SIZES.narrow, `${name}-narrow.png`, true)
      await page.setViewportSize(SIZES.wide)
    },
  }
}

type Scene = ReturnType<typeof scene>

async function checkRows(page: Page, felix: Scene) {
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

  // Fetching: the size moves into a muted "Fetching", led by a still icon, and nothing on the row
  // draws a line or moves: there is no progress to show.
  await button(page, 'Save', ZIP).click()
  const zip = row(page, ZIP)
  await zip.locator('[data-field="fetching"]').waitFor()
  equal(
    await zip.evaluate((element) => {
      const fetching = element.querySelector('[data-field="fetching"]')
      const box = element.getBoundingClientRect()
      return {
        says: fetching?.textContent,
        color: fetching && getComputedStyle(fetching).color,
        icon: fetching?.querySelector('svg')?.getBoundingClientRect().width,
        size: element.querySelector('[data-field="size"]') !== null,
        lines: [...element.querySelectorAll('*')].filter((part) => {
          const at = part.getBoundingClientRect()
          return at.height > 0 && at.height <= 3 && at.width > box.width / 4
        }).length,
        moving: document.getAnimations().filter((animation) => {
          const target = animation.effect instanceof KeyframeEffect ? animation.effect.target : null
          return target instanceof Node && element.contains(target)
        }).length,
      }
    }),
    { says: 'Fetching · 48.6 MB', color: MUTED, icon: 14, size: false, lines: 0, moving: 0 },
    'a fetch says "Fetching · 48.6 MB" in muted, led by a still 14 px icon, with no track and nothing moving',
  )

  // Failed: what went wrong in red, why in muted, and Retry.
  await button(page, 'Open', SHEET).click()
  await felix.answer(SHEET, 'open', { ok: false, reason: 'offline' })
  equal(
    await failedRow(row(page, SHEET)),
    { text: 'Couldn’t fetch · offline', says: ['Couldn’t fetch', RED], why: ['· offline', MUTED], retry: true },
    'a fetch that failed offline says "Couldn’t fetch" in red and "· offline" in muted, with Retry',
  )
  await felix.capture('attachments-states', button(page, 'Open', PHOTO))
  // The mock's risky scene is the same rows, with the pointer on the program's Open.
  await felix.capture('attachments-risky', button(page, 'Open', PROGRAM))

  await button(page, 'Retry', SHEET).click()
  await felix.answer(SHEET, 'open', { ok: true })
  equal(
    [(await asked(page)).slice(-2), await row(page, SHEET).getAttribute('data-state')],
    [
      [
        { action: 'open', blobId: felix.idOf(SHEET) },
        { action: 'open', blobId: felix.idOf(SHEET) },
      ],
      'rest',
    ],
    'Retry asks the shell again for the same thing on the same file, and a file that opens leaves the row at rest',
  )

  // A save the shell could not finish offers Retry. A closed save dialog then says nothing.
  await button(page, 'Save', SHEET).click()
  await felix.answer(SHEET, 'save', { ok: false, reason: 'failed' })
  const failedSave = await failedRow(row(page, SHEET))
  equal(
    { text: failedSave.text, retry: failedSave.retry },
    { text: 'Couldn’t save', retry: true },
    'a save the shell could not finish says "Couldn’t save", with Retry',
  )
  await button(page, 'Retry', SHEET).click()
  await felix.answer(SHEET, 'save', { ok: false, reason: 'cancelled' })
  equal(
    await row(page, SHEET).getAttribute('data-state'),
    'rest',
    'a closed save dialog leaves the row at rest, saying nothing',
  )

  // Reasons trying again cannot help: they say why, and offer no Retry.
  for (const [name, reason, text] of [
    [SHEET, 'too-large', 'Couldn’t fetch · too large'],
    [PHOTO, 'gone', 'Couldn’t fetch · no longer on the server'],
  ] as const) {
    // oxlint-disable-next-line no-await-in-loop -- one file after the other, on the one page
    await button(page, 'Save', name).click()
    // oxlint-disable-next-line no-await-in-loop -- the answer comes after the click
    await felix.answer(name, 'save', { ok: false, reason })
    // oxlint-disable-next-line no-await-in-loop -- read once the row shows it
    const shown = await failedRow(row(page, name))
    equal(
      { text: shown.text, retry: shown.retry },
      { text, retry: false },
      `a ${reason} save says "${text}", with no Retry`,
    )
  }
}

/**
 * A fetch outlives its row: the conversation closes while the shell fetches and opens again,
 * and the row still says it is fetching, with nothing to click that would ask the shell twice.
 */
async function checkFetchOutlivesRow(page: Page) {
  const before = (await asked(page)).length
  await open(page, 'Notes from Thursday')
  await open(page, SUBJECT)
  const zip = row(page, ZIP)
  await zip.waitFor()
  await zip.locator('[data-field="name"]').click()
  equal(
    [await zip.getAttribute('data-state'), await zip.getByRole('button').count(), (await asked(page)).length - before],
    ['fetching', 0, 0],
    'a fetch the conversation closed on still shows when it opens again, and asks the shell nothing more',
  )
}

/** The program: marked at rest, and Open goes to the shell once, with no warning of the page's own. */
async function checkProgram(page: Page, felix: Scene) {
  const before = (await asked(page)).length
  await button(page, 'Open', PROGRAM).click()
  await row(page, PROGRAM).locator('[data-field="fetching"]').waitFor()
  equal(
    [
      (await asked(page)).slice(before),
      await page.locator('section[aria-label="Reader"]').getByRole('alertdialog').count(),
      await page.locator('section[aria-label="Reader"]').getByRole('dialog').count(),
    ],
    [[{ action: 'open', blobId: felix.idOf(PROGRAM) }], 0, 0],
    'Open on a program asks the shell once, whose warning is the only one: the page shows none of its own',
  )
  await felix.answer(PROGRAM, 'open', { ok: false, reason: 'declined' })
  equal(
    await row(page, PROGRAM).getAttribute('data-state'),
    'rest',
    "declining the shell's warning leaves the row at rest, saying nothing",
  )
}

/** At the narrowest window the card is a third as wide, and a failed program row wraps its status and Retry under its name. */
async function checkNarrowest(page: Page, felix: Scene) {
  await button(page, 'Open', PROGRAM).click()
  await felix.answer(PROGRAM, 'open', { ok: false, reason: 'offline' })
  await page.setViewportSize(NARROWEST)
  const program = row(page, PROGRAM)
  await program.scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(ARTIFACTS, 'attachments-640.png'), animations: 'disabled' })
  const fits = await program.evaluate((element) => {
    const card = element.closest('ul')?.getBoundingClientRect()
    if (!card) throw new Error('the row is in no card')
    return {
      wrapped: element.getBoundingClientRect().height > 48,
      outside: [...element.querySelectorAll('[data-field], button')]
        .filter((part) => {
          const at = part.getBoundingClientRect()
          return at.left < card.left - 0.5 || at.right > card.right + 0.5
        })
        .map((part) => part.getAttribute('data-field') ?? part.getAttribute('aria-label')),
    }
  })
  equal(
    fits,
    { wrapped: true, outside: [] },
    '640 px: a failed program row wraps, and every part of it stays in the card',
  )
  await page.setViewportSize(SIZES.wide)
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
  const opened = await openPage(browser, server.url, 'trace-attachments.zip', { deviceScaleFactor: 2 })
  const { page, errors } = opened
  try {
    await page.waitForFunction(() => window.letterboxDev !== undefined)
    await page.evaluate(([address, password]) => window.letterboxDev?.signIn(address, password), [
      ME,
      seed.seed.password,
    ] as const)
    await yourTurn(page).first().waitFor()
    const files = (await page.evaluate((subject) => window.letterboxDev?.attachments(subject), SUBJECT)) ?? []
    const felix = scene(page, new Map(files.map((file) => [file.name, file.blobId])))
    await page.evaluate(() => {
      const calls: Call[] = []
      const waiting: { call: Call; resolve: (outcome: AttachmentOutcome) => void }[] = []
      const ask = (action: Call['action']) => (blobId: string) =>
        new Promise<AttachmentOutcome>((resolve) => {
          const call = { action, blobId }
          calls.push(call)
          waiting.push({ call, resolve })
        })
      window.letterbox = {
        platform: 'linux',
        connect: () => {},
        openAttachment: ask('open'),
        saveAttachment: ask('save'),
        onOpenConversation: () => () => {},
      }
      window.fileStub = {
        asked: calls,
        answer: (call, outcome) => {
          const index = waiting.findIndex((one) => one.call.action === call.action && one.call.blobId === call.blobId)
          const [found] = index === -1 ? [] : waiting.splice(index, 1)
          found?.resolve(outcome)
          return found !== undefined
        },
      }
    })
    await open(page, SUBJECT)
    await row(page, PROGRAM).waitFor()
    await checkRows(page, felix)
    await checkFetchOutlivesRow(page)
    await checkProgram(page, felix)
    await checkNarrowest(page, felix)
    await felix.answer(ZIP, 'save', { ok: true })
    equal(appErrors(errors), [], 'the attachments page logged no errors')
  } finally {
    await opened.close()
    await server.close()
    await provider.close()
    await stopChildren()
  }
}
