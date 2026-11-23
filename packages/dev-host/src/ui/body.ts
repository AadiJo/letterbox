// The UI check of a message's remote images and quoted history (Body.tsx, ImagesChip.tsx,
// images.ts), pick B of the body mocks, on the `updates` seed:
//   - The Long Read's issue in Updates: one-line placeholders with their alt text, or "Image"
//     when there is none; the "Images off" chip and its menu, which notes the one tracker. I
//     shows the images: every non-tracker image comes through the core's `image` request from
//     the fake web, which never sees the tracker, and lands in the frame as a data: URL, a CSS
//     image included. Block images again brings the placeholders back. A fetch still under
//     way when images are blocked again starts nothing after it, and at most three run at once.
//   - The older newsletter: two trackers, said in the plural, and an image the fake web does
//     not serve, which stays a placeholder.
//   - Ines's HTML reply: a logo and no trackers, so its menu says nothing about trackers, and
//     Show images from the menu. Its quoted history folds: the frame holds the new part only,
//     with no link, base, iframe or script, and opens to the whole body.
//   - Dara's plain-text reply: the quote folds behind one line and opens to each level on its
//     rule. Folded rows preview the new text only.
// Like attachments.ts, it builds the dev host's parts in this process, so it can read and hold
// the fake web. Writes body-images-blocked, body-images-shown, body-quote-folded and
// body-quote-open at twice their pixels, at 1440×900 and 1024×700 (-narrow), to compare with
// the mocks in images.html and quotes.html.

import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { devSeeds } from '@letterbox/sim-provider/seeds'
import type { FakeWeb } from '@letterbox/sim-provider/web'
import type { Browser, Page } from 'playwright'
import { stopChildren, logChildrenTo } from '../children.ts'
import type { Paths } from '../core.ts'
import { startServer } from '../server.ts'
import { startSim } from '../sim.ts'
import { appErrors, ARTIFACTS, equal, openPage, type Relay, root, SIZES } from './record.ts'
import { open } from './reply-page.ts'
import { nav, senderRow } from './updates-edges.ts'

const seed = devSeeds.updates
const STATE = join(root, '.letterbox/ui-check-body')

const ISSUE = 'Issue 212: the quiet web'
const OLDER = 'Five essays for the weekend'
const INES = 'Invoice 2291, line 4'
const DARA = 'Quote for the kitchen shelves'

/** The issue's images, in the order its HTML names them: the core's `images.remote`. */
const ISSUE_IMAGES = ['masthead.png', 'rule.png', 'hillside.jpg', 'seeds.jpg', 'boat.jpg'].map(
  (file) => `https://images.longread.example/issue-212/${file}`,
)

const MUTED = 'rgb(163, 163, 163)'
const FG = 'rgb(245, 245, 245)'
const FG2 = 'rgb(210, 210, 210)'
const PILL = 'rgba(255, 255, 255, 0.08)'
const HOVER = PILL

const chip = (page: Page) => page.locator('[data-message="open"] [data-field="images-chip"]')
const menu = (page: Page) => page.getByRole('menu', { name: 'Images' })
const frame = (page: Page) => page.locator('[data-message="open"] iframe[title="Message"]')

/** What the open message's frame shows where images go: each placeholder, each image, and the CSS image. */
const frameImages = (page: Page) =>
  frame(page).evaluate((element) => {
    const doc = element instanceof HTMLIFrameElement ? element.contentDocument : null
    if (!doc) return null
    const view = doc.defaultView
    return {
      placeholders: [...doc.querySelectorAll('span[data-letterbox-image]')].map((span) => ({
        alt: span.textContent,
        label: view?.getComputedStyle(span, '::after').content,
        height: span.getBoundingClientRect().height,
      })),
      images: [...doc.querySelectorAll('img')].map((image) => ({
        alt: image.alt,
        type: image.src.slice(0, image.src.indexOf(';')),
        loaded: image.complete && image.naturalWidth > 0,
      })),
      // The sender's elements that draw a CSS image. The root carries the URLs once they are shown.
      css: [...doc.querySelectorAll('body [style*="--letterbox-image-"]')].map((styled) =>
        (view?.getComputedStyle(styled).backgroundImage ?? '').slice(0, 26),
      ),
    }
  })

/** Waits until the open message's frame holds `count` images, each loaded. */
const imagesLoaded = (page: Page, count: number) =>
  page.waitForFunction((wanted) => {
    const doc = document.querySelector<HTMLIFrameElement>(
      '[data-message="open"] iframe[title="Message"]',
    )?.contentDocument
    const images = [...(doc?.querySelectorAll('img') ?? [])]
    return images.length === wanted && images.every((image) => image.complete && image.naturalWidth > 0)
  }, count)

/** Waits until the open message's frame shows `count` placeholders and no image. */
const placeholdersBack = (page: Page, count: number) =>
  page.waitForFunction((wanted) => {
    const doc = document.querySelector<HTMLIFrameElement>(
      '[data-message="open"] iframe[title="Message"]',
    )?.contentDocument
    return (
      doc?.querySelectorAll('span[data-letterbox-image]').length === wanted && doc.querySelectorAll('img').length === 0
    )
  }, count)

/** The chip's look: what it says, its choice, and its colors. */
const chipLooks = (page: Page) =>
  chip(page).evaluate((element) => ({
    text: element.textContent,
    images: element.getAttribute('data-images'),
    height: element.getBoundingClientRect().height,
    color: getComputedStyle(element).color,
    background: getComputedStyle(element).backgroundColor,
  }))

/** The open menu: its choices, their keys, and its note about trackers, if any. */
const menuSays = (page: Page) =>
  menu(page).evaluate((element) => ({
    items: [...element.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent),
    note: element.querySelector('[data-field="tracker-note"]')?.textContent ?? null,
  }))

/** The `image` requests the page sent, in order: each one's id and the index it asked for. */
const imageRequests = (relay: Relay) =>
  relay
    .fromPage()
    .filter((text) => text.includes('"method":"image"'))
    .map((text) => {
      const { id, request } = JSON.parse(text) as { id: string; request: { index: number } }
      return { id, index: request.index }
    })

/** Takes the page at 1440×900 as `<name>.png` and at 1024×700 as `<name>-narrow.png`, then leaves it wide. */
async function capture(page: Page, name: string) {
  await page.screenshot({ path: join(ARTIFACTS, `${name}.png`), animations: 'disabled' })
  await page.setViewportSize(SIZES.narrow)
  await page.screenshot({ path: join(ARTIFACTS, `${name}-narrow.png`), animations: 'disabled' })
  await page.setViewportSize(SIZES.wide)
}

/** The issue: placeholders, the chip and its menu, I, the fetches, and Block images again. */
async function checkIssue(page: Page, relay: Relay, web: FakeWeb) {
  const { requested } = web
  await nav(page, 'Updates').click()
  await senderRow(page, 'The Long Read').click()
  await page.locator('[data-field="open-subject"]', { hasText: ISSUE }).waitFor()
  await placeholdersBack(page, 4)
  equal(
    await frameImages(page),
    {
      placeholders: [
        { alt: 'The Long Read', label: 'none', height: 30 },
        { alt: 'A hillside village at dusk', label: 'none', height: 30 },
        { alt: '', label: '"Image"', height: 30 },
        { alt: 'A small boat at sea', label: 'none', height: 30 },
      ],
      images: [],
      css: ['none'],
    },
    'blocked, each image is a 30 px placeholder with its alt text, or "Image" when it has none, and the CSS image is unset',
  )
  equal(
    await chipLooks(page),
    { text: 'Images off', images: 'blocked', height: 20, color: FG2, background: PILL },
    'the address line ends in a 20 px "Images off" chip',
  )
  equal(requested(), [], 'with images off, the fake web is asked for nothing')

  await chip(page).click()
  equal(
    [await menuSays(page), await chipLooks(page).then((looks) => [looks.color, looks.background])],
    [{ items: ['Show imagesI'], note: '1 tracker removed. Showing images won’t bring it back.' }, [FG, HOVER]],
    'the chip opens a menu with one choice, Show images (I), and notes the one tracker; open, the chip lifts',
  )
  await capture(page, 'body-images-blocked')
  await page.keyboard.press('Escape')
  await menu(page).waitFor({ state: 'detached' })

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
  await chip(page).click()
  equal((await menuSays(page)).items, ['Block images again'], 'shown, the menu offers Block images again')
  await menu(page).getByRole('menuitem').click()
  await page.locator('[data-field="images-chip"][data-images="blocked"]').waitFor()
  for (const hold of held) hold.release()
  await answered
  // Showing them again is a command, which the page sends after it has read every answer before it.
  await page.keyboard.press('i')
  await imagesLoaded(page, 4)
  const sent = relay.fromPage().filter((text) => text.includes('"method":"image"') || text.includes('"set-images"'))
  const kinds = sent.map((text) =>
    text.includes('"set-images"') ? (JSON.parse(text) as { command: { show: string } }).command.show : 'image',
  )
  equal(
    kinds.slice(0, 6),
    ['message', 'image', 'image', 'image', 'blocked', 'message'],
    'once images are blocked again, the fetches under way start no more: no image is asked for before they show again',
  )

  equal(
    await frameImages(page),
    {
      placeholders: [],
      images: [
        { alt: 'The Long Read', type: 'data:image/png', loaded: true },
        { alt: 'A hillside village at dusk', type: 'data:image/jpeg', loaded: true },
        { alt: '', type: 'data:image/jpeg', loaded: true },
        { alt: 'A small boat at sea', type: 'data:image/jpeg', loaded: true },
      ],
      css: ['url("data:image/png;base64'],
    },
    'shown, every image is in the frame as a data: URL of its own type, and the CSS image as a custom property',
  )
  equal(
    [...new Set(requested())].toSorted(),
    ISSUE_IMAGES.toSorted(),
    'the fake web was asked for every image the issue names and nothing else: never its tracker',
  )
  equal(
    [
      await chipLooks(page).then((looks) => [looks.text, looks.images, looks.color]),
      await frame(page).getAttribute('sandbox'),
    ],
    [['Images on', 'message', MUTED], 'allow-same-origin'],
    'shown, the chip reads "Images on" in muted, and the frame stays sandboxed without scripts',
  )
  await capture(page, 'body-images-shown')

  await chip(page).click()
  await menu(page).getByRole('menuitem', { name: 'Block images again' }).click()
  await placeholdersBack(page, 4)
  equal(
    [(await frameImages(page))?.css, (await chipLooks(page)).text],
    [['none'], 'Images off'],
    'Block images again brings back every placeholder and unsets the CSS image',
  )
}

/** The older newsletter: two trackers in the plural, and an image the fake web does not serve stays a placeholder. */
async function checkOlder(page: Page, relay: Relay) {
  await nav(page, 'Inbox').click()
  await open(page, OLDER)
  await chip(page).click()
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
    (await frameImages(page))?.placeholders.map((placeholder) => placeholder.alt),
    ["This week's cover"],
    'an image the core could not fetch stays its placeholder',
  )
}

/** Ines's HTML reply: no trackers, Show images from the menu, and its quoted history folded and open. */
async function checkInes(page: Page) {
  await nav(page, 'People').click()
  await open(page, INES)
  await chip(page).click()
  equal(
    await menuSays(page),
    { items: ['Show imagesI'], note: null },
    'with no trackers, the menu says nothing about them',
  )
  await menu(page).getByRole('menuitem', { name: 'Show images' }).click()
  await imagesLoaded(page, 1)

  const folded = await frame(page).evaluate((element) => {
    const doc = element instanceof HTMLIFrameElement ? element.contentDocument : null
    return {
      text: doc?.body.innerText.trim().replace(/\s+/g, ' '),
      // The frame's own `<base target="_blank">` names no URL. One from the mail would.
      hostile: doc?.querySelectorAll('link, base[href], iframe, script').length,
      quote: doc?.querySelectorAll('.gmail_quote, blockquote').length,
    }
  })
  equal(
    folded,
    {
      text: 'Hi Robin, Our accounts team flagged line 4. It looks like the October hours were billed twice, once on the weekly sheet and again on the monthly summary. I can issue a credit note for €380, or reissue the invoice without the line. Which would you prefer for your records? Ines',
      hostile: 0,
      quote: 0,
    },
    'folded, the frame holds the new part only: its text, no quote, and no link, base, iframe or script',
  )
  const line = page.locator('[data-message="open"] [data-field="quote-line"]')
  equal(
    await line.evaluate((element) => [element.textContent, element.getAttribute('aria-expanded')]),
    ['Quoted history·all in this conversationShow', 'false'],
    'under the frame, the quoted history folds behind one line that says it is all in this conversation',
  )
  await line.click()
  await page.waitForFunction(() =>
    document
      .querySelector<HTMLIFrameElement>('[data-message="open"] iframe[title="Message"]')
      ?.contentDocument?.querySelector('.gmail_quote'),
  )
  await imagesLoaded(page, 1)
  equal(
    [await line.evaluate((element) => element.textContent?.endsWith('Hide')), await line.getAttribute('aria-expanded')],
    [true, 'true'],
    'Show opens the whole body in the frame, images still shown, and the line reads Hide',
  )
}

/** Dara's plain-text reply: the quote folds, opens level by level, and folded rows preview new text only. */
async function checkDara(page: Page) {
  await open(page, DARA)
  const message = page.locator('[data-message="open"]')
  const line = message.locator('[data-field="quote-line"]')
  equal(
    [
      await message.locator('[data-field="body"] > p').evaluateAll((all) => all.map((p) => p.textContent)),
      await line.evaluate((element) => {
        const box = element.getBoundingClientRect()
        return { height: box.height, top: getComputedStyle(element).borderTopWidth, text: element.textContent }
      }),
      await message.locator('[data-field="quoted"]').count(),
    ],
    [
      [
        'Hi Robin,',
        'Oak comes in at €1,140 fitted, birch ply at €860. Happy to bring samples by next week.',
        'Both prices include the brackets and making good the wall. The ply can be oiled or left raw. Raw marks more easily near the cooker.',
        'Dara',
      ],
      { height: 36, top: '1px', text: 'Quoted history·all in this conversationShow' },
      0,
    ],
    'folded, a plain reply shows its new text, then a 36 px line with a hairline on top, and no quoted text',
  )
  equal(
    await page
      .locator('[data-message="folded"]')
      .evaluateAll((rows) => rows.map((element) => element.querySelector('[data-field="preview"]')?.textContent)),
    [
      'Hi Dara, We’re after three open shelves for the kitchen wall, about 1.2 m each. Could you quote for oak, and for something cheaper? Robin',
      'Hi Robin, Happy to. I’ll measure up on Thursday if someone’s in. Do you know if there are pipes behind that wall? Dara',
    ],
    'folded rows preview each message’s new text',
  )
  await line.scrollIntoViewIfNeeded()
  await capture(page, 'body-quote-folded')

  await line.click()
  const levels = await message.locator('[data-field="quote-level"]').evaluateAll((all) =>
    all.map((level) => ({
      cite: level.querySelector(':scope > .text-cite')?.textContent,
      rule: getComputedStyle(level).borderLeftWidth,
      first: level.querySelector(':scope > .text-quote')?.textContent,
    })),
  )
  equal(
    [levels, await line.textContent()],
    [
      [
        {
          cite: 'On Fri, Feb 20, 2026 at 8:00 PM, Dara Quinn <dara@quinnjoinery.test> wrote:',
          rule: '2px',
          first: 'Hi Robin,',
        },
        {
          cite: 'On Fri, Feb 20, 2026 at 12:00 AM, Robin Vale <robin@vale.test> wrote:',
          rule: '2px',
          first: 'Hi Dara,',
        },
      ],
      'Quoted history·all in this conversationHide',
    ],
    'Show opens each quoted message a level in, on a 2 px rule under its attribution, and the line reads Hide',
  )
  await message.locator('[data-field="quoted"]').scrollIntoViewIfNeeded()
  await capture(page, 'body-quote-open')
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
    await checkInes(page)
    await checkDara(page)
    equal(remote, [], 'the page never reached past 127.0.0.1: every image came through the core')
    equal(appErrors(errors), [], 'the body page logged no errors')
  } finally {
    await opened.close()
    await server.close()
    await running.close()
    await stopChildren()
  }
}
