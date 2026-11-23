// The UI check of a message's remote images and quoted history (Body.tsx, ImagesChip.tsx,
// images.ts), pick B of the body mocks, on the `updates` seed. This file has the images:
//   - The Long Read's issue in Updates: one-line placeholders with their alt text, or "Image"
//     when there is none; the "Images off" chip and its menu, which notes the one tracker, fits
//     a 640 px window and gives focus back to the chip on Esc. I shows the images: every
//     non-tracker image comes through the core's `image` request from the fake web, which never
//     sees the tracker, and lands in the frame as a data: URL, a CSS image included. At most
//     three fetches run at once. Blocking again starts no more fetches, and an answer that
//     arrives after it, held at the relay, never lands. Block images again brings the placeholders back.
//   - The older newsletter: two trackers, said in the plural, and an image the fake web does
//     not serve, which stays a placeholder.
// body-quotes.ts has the rest: Harbour Lane's hostile statements, the quoted history, and Updates
// moving to a new message. Like attachments.ts, it builds the dev host's parts in this process,
// so it can read and hold the fake web. Writes body-images-blocked, body-images-shown,
// body-quote-folded and body-quote-open at twice their pixels, at 1440×900 and 1024×700
// (-narrow), to compare with the mocks in images.html and quotes.html, and body-images-menu-640.

import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { devSeeds } from '@letterbox/sim-provider/seeds'
import type { FakeWeb } from '@letterbox/sim-provider/web'
import type { Request } from '@letterbox/protocol'
import type { Browser, Page } from 'playwright'
import { logChildrenTo, stopChildren } from '../children.ts'
import type { Paths } from '../core.ts'
import { startServer } from '../server.ts'
import { startSim } from '../sim.ts'
import {
  capture,
  chipLooks,
  chipOf,
  focused,
  frameOf,
  menu,
  menuSays,
  NEWEST,
  readFrame,
  waitImages,
} from './body-frame.ts'
import { checkDara, checkDeep, checkInes, checkStatement, checkUpdatesMovesOn } from './body-quotes.ts'
import { appErrors, ARTIFACTS, equal, openPage, type Relay, root } from './record.ts'
import { open } from './reply-page.ts'
import { nav, senderRow } from './updates-edges.ts'

const seed = devSeeds.updates
const STATE = join(root, '.letterbox/ui-check-body')

const ISSUE = 'Issue 212: the quiet web'
const OLDER = 'Five essays for the weekend'

/** The issue's images, in the order its HTML names them: the core's `images.remote`. */
const ISSUE_IMAGES = ['masthead.png', 'rule.png', 'hillside.jpg', 'seeds.jpg', 'boat.jpg'].map(
  (file) => `https://images.longread.example/issue-212/${file}`,
)
const PLACEHOLDERS = 4

const MUTED = 'rgb(163, 163, 163)'
const FG = 'rgb(245, 245, 245)'
const FG2 = 'rgb(210, 210, 210)'
const PILL = 'rgba(255, 255, 255, 0.08)'
const HOVER = PILL
const NARROWEST = { width: 640, height: 700 }

/** The `image` requests the page sent, in order: each one's id and the index it asked for. */
const imageRequests = (relay: Relay) =>
  relay
    .fromPage()
    .filter((text) => text.includes('"method":"image"'))
    .map((text) => {
      const { id, request } = JSON.parse(text) as { id: string; request: { index: number } }
      return { id, index: request.index }
    })

/** The open message's frame shows only placeholders again. */
const blockedAgain = (page: Page) => waitImages(page, NEWEST, 0, PLACEHOLDERS)

/** Blocks the newest open message's images from its menu, and waits for the placeholders. */
async function blockFromMenu(page: Page) {
  await chipOf(page).click()
  await menu(page).getByRole('menuitem', { name: 'Block images again' }).click()
  await page.locator('[data-message="open"] [data-field="images-chip"][data-images="blocked"]').waitFor()
  await blockedAgain(page)
}

/** At 640 px the menu keeps inside the reader and the window, and its note wraps. */
async function checkNarrowestMenu(page: Page) {
  await page.setViewportSize(NARROWEST)
  await chipOf(page).click()
  const fit = await menu(page).evaluate((element) => {
    const box = element.getBoundingClientRect()
    let reader = element.parentElement
    while (reader && !/auto|scroll/.test(getComputedStyle(reader).overflowY)) reader = reader.parentElement
    const bounds = reader?.getBoundingClientRect()
    const note = element.querySelector('[data-field="tracker-note"]')?.getBoundingClientRect().height ?? 0
    return {
      inside: bounds !== undefined && box.left >= bounds.left && box.right <= bounds.right && box.right <= innerWidth,
      wraps: note > 40,
    }
  })
  equal(
    fit,
    { inside: true, wraps: true },
    'at 640 px the menu keeps inside the reader and the window, its note wrapped',
  )
  await page.screenshot({ path: join(ARTIFACTS, 'body-images-menu-640.png'), animations: 'disabled' })
  await page.keyboard.press('Escape')
  await page.setViewportSize({ width: 1440, height: 900 })
}

/** The issue: placeholders, the chip and its menu, I, the fetches, and Block images again. */
async function checkIssue(page: Page, relay: Relay, web: FakeWeb) {
  const { requested } = web
  await nav(page, 'Updates').click()
  await senderRow(page, 'The Long Read').click()
  await page.locator('[data-field="open-subject"]', { hasText: ISSUE }).waitFor()
  await blockedAgain(page)
  const blocked = await readFrame(page, NEWEST)
  equal(
    [blocked?.placeholders, blocked?.images, blocked?.css.drawn],
    [
      [
        { alt: 'The Long Read', label: 'none', height: 30 },
        { alt: 'A hillside village at dusk', label: 'none', height: 30 },
        { alt: '', label: '"Image"', height: 30 },
        { alt: 'A small boat at sea', label: 'none', height: 30 },
      ],
      [],
      ['none'],
    ],
    'blocked, each image is a 30 px placeholder with its alt text, or "Image" when it has none, and the CSS image is unset',
  )
  equal(
    await chipLooks(chipOf(page)),
    { text: 'Images off', images: 'blocked', height: 20, color: FG2, background: PILL },
    'the address line ends in a 20 px "Images off" chip',
  )
  equal(requested(), [], 'with images off, the fake web is asked for nothing')

  await chipOf(page).click()
  equal(
    [await menuSays(page), await chipLooks(chipOf(page)).then((looks) => [looks.color, looks.background])],
    [{ items: ['Show imagesI'], note: '1 tracker removed. Showing images won’t bring it back.' }, [FG, HOVER]],
    'the chip opens a menu with one choice, Show images (I), and notes the one tracker; open, the chip lifts',
  )
  await capture(page, 'body-images-blocked')
  await page.keyboard.press('Escape')
  await menu(page).waitFor({ state: 'detached' })
  equal(await focused(chipOf(page)), true, 'Esc puts the menu away and gives focus back to the chip')
  await checkNarrowestMenu(page)

  // Three fetches at most run at once: with the first three held, nothing else is asked for.
  const held = ISSUE_IMAGES.slice(0, 3).map((url) => web.hold(url))
  await page.keyboard.press('i')
  await Promise.all(held.map((hold) => hold.arrived))
  const firstRequests = imageRequests(relay)
  // The core fetches the three at once, so they reach the fake web in any order.
  equal(
    [firstRequests.map((request) => request.index), requested().toSorted()],
    [[0, 1, 2], ISSUE_IMAGES.slice(0, 3).toSorted()],
    'I shows the images: the page asks the core for three at a time, in the order the HTML names them',
  )

  // Blocked again while they are held: the core answers each `blocked`, and the page starts no more.
  const answered = Promise.all(firstRequests.map(({ id }) => relay.sees(`{"kind":"response","id":"${id}"`)))
  await chipOf(page).click()
  equal((await menuSays(page)).items, ['Block images again'], 'shown, the menu offers Block images again')
  await menu(page).getByRole('menuitem').click()
  await page.locator('[data-field="images-chip"][data-images="blocked"]').waitFor()
  for (const hold of held) hold.release()
  await answered
  // Showing them again is a command, which the page sends after it has read every answer before it.
  await page.keyboard.press('i')
  await waitImages(page, NEWEST, PLACEHOLDERS)
  const kinds = relay
    .fromPage()
    .filter((text) => text.includes('"method":"image"') || text.includes('"set-images"'))
    .map((text) =>
      text.includes('"set-images"') ? (JSON.parse(text) as { command: { show: string } }).command.show : 'image',
    )
  equal(
    kinds.slice(0, 6),
    ['message', 'image', 'image', 'image', 'blocked', 'message'],
    'once images are blocked again, the fetches under way start no more: no image is asked for before they show again',
  )
  const shown = await readFrame(page, NEWEST)
  equal(
    [shown?.placeholders, shown?.images, shown?.css.drawn],
    [
      [],
      [
        { alt: 'The Long Read', type: 'data:image/png', loaded: true },
        { alt: 'A hillside village at dusk', type: 'data:image/jpeg', loaded: true },
        { alt: '', type: 'data:image/jpeg', loaded: true },
        { alt: 'A small boat at sea', type: 'data:image/jpeg', loaded: true },
      ],
      ['url("data:image/png;base64'],
    ],
    'shown, every image is in the frame as a data: URL of its own type, and the CSS image under the body’s prefix',
  )
  equal(
    [...new Set(requested())].toSorted(),
    ISSUE_IMAGES.toSorted(),
    'the fake web was asked for every image the issue names and nothing else: never its tracker',
  )
  equal(
    [
      await chipLooks(chipOf(page)).then((looks) => [looks.text, looks.images, looks.color]),
      await frameOf(page, NEWEST).getAttribute('sandbox'),
    ],
    [['Images on', 'message', MUTED], 'allow-same-origin'],
    'shown, the chip reads "Images on" in muted, and the frame stays sandboxed without scripts',
  )
  await capture(page, 'body-images-shown')
  await checkLateAnswer(page, relay)
  await blockFromMenu(page)
  equal((await readFrame(page, NEWEST))?.css.drawn, ['none'], 'Block images again unsets the CSS image')
}

/** The page's request for the issue's first image, the masthead. */
const masthead = (request: Request) => request.method === 'image' && request.index === 0

/**
 * An answer the core sent, held at the relay until images were blocked again, never lands: the
 * masthead's bytes arrive after the block, and when images show once more, with the masthead's
 * new answer held too, it is still a placeholder while the rest load.
 */
async function checkLateAnswer(page: Page, relay: Relay) {
  await blockFromMenu(page)
  const late = relay.holdAnswer(masthead)
  await page.keyboard.press('i')
  await late.answered
  await waitImages(page, NEWEST, PLACEHOLDERS - 1, 1)
  await blockFromMenu(page)
  const next = relay.holdAnswer(masthead)
  late.release()
  // The page reads the released answer before the core's answer to this command.
  await page.keyboard.press('i')
  await waitImages(page, NEWEST, PLACEHOLDERS - 1, 1)
  equal(
    (await readFrame(page, NEWEST))?.placeholders.map((placeholder) => placeholder.alt),
    ['The Long Read'],
    'an image answer that arrives after images were blocked again never lands in the frame',
  )
  next.release()
  await waitImages(page, NEWEST, PLACEHOLDERS)
}

/** The older newsletter: two trackers in the plural, and an image the fake web does not serve stays a placeholder. */
async function checkOlder(page: Page, relay: Relay) {
  await nav(page, 'Inbox').click()
  await open(page, OLDER)
  await chipOf(page).click()
  equal(
    (await menuSays(page)).note,
    '2 trackers removed. Showing images won’t bring them back.',
    'two trackers are said in the plural',
  )
  const failed = relay.sees('"method":"image","ok":false')
  await menu(page).getByRole('menuitem', { name: 'Show images' }).click()
  await failed
  await page.locator('[data-field="images-chip"][data-images="message"]').waitFor()
  equal(
    (await readFrame(page, NEWEST))?.placeholders.map((placeholder) => placeholder.alt),
    ["This week's cover"],
    'an image the core could not fetch stays its placeholder',
  )
}

export async function checkBody(browser: Browser) {
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
  const server = await startServer({ paths, port: 0, relay: true, sim: running.sim })
  const opened = await openPage(browser, server.url, 'trace-body.zip', { deviceScaleFactor: 2 })
  const { page, relay, errors, remote } = opened
  try {
    await checkIssue(page, relay, running.web)
    await checkOlder(page, relay)
    await checkStatement(page)
    await checkInes(page)
    await checkDara(page)
    await checkDeep(page)
    await checkUpdatesMovesOn(page, running.mailbox)
    equal(remote, [], 'the page never reached past 127.0.0.1: every image came through the core')
    equal(appErrors(errors), [], 'the body page logged no errors')
  } finally {
    await opened.close()
    await server.close()
    await running.close()
    await stopChildren()
  }
}
