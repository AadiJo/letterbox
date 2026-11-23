// The UI check of HTML mail in the dark reader (Body.tsx, ColorsSwitch.tsx, colors.ts), pick C
// of the dark-mode mocks, on the `updates` seed with three messages of its own:
//   - The Long Read's issue, branded: dark by default, restyled with the core's palette, its text
//     reading at 4.5:1 or more on what it is painted on. Original shows the sender's colors on a
//     dimmed card. The choice reaches the sender's older newsletter and survives a reload.
//   - Hana's schedule, a person's plain HTML: dark, in the reader's type and colors.
//   - A machine's notice whose CSS tries to set and to read the color variables: it can do neither,
//     as they carry the body's random prefix.
//   - A message whose From has no address: no switch.
//   - Harbour Lane's statement: the open quote's frame takes the same scheme as the message's.
// Builds the dev host's parts in this process, as body.ts does. Writes body-colors-branded-dark,
// body-colors-branded-original and body-colors-plain-dark at twice their pixels, at 1440×900,
// 1920×1080 (-1920) and 1024×700 (-narrow), and body-colors-branded-dark-640, to compare with the
// mocks in dark.html (dark-c-branded, dark-c-original, dark-c-plain).

import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { SeedMessage } from '@letterbox/sim-provider/contract'
import { type DevSeed, devSeeds } from '@letterbox/sim-provider/seeds'
import type { Browser, Page } from 'playwright'
import { logChildrenTo, stopChildren } from '../children.ts'
import type { Paths } from '../core.ts'
import { startServer } from '../server.ts'
import { startSim } from '../sim.ts'
import { frameOf, NEWEST, opened, type Where } from './body-frame.ts'
import { appErrors, ARTIFACTS, capture, equal, openPage, root } from './record.ts'
import { open } from './reply-page.ts'
import { nav, senderRow } from './updates-edges.ts'

const STATE = join(root, '.letterbox/ui-check-body-colors')

const ISSUE = 'Issue 212: the quiet web'
const OLDER = 'Five essays for the weekend'
const PLAIN = 'Print schedule for issue 12'
const PROBE = 'Your notice settings'
const NOWHERE = 'A note from nowhere'
const STATEMENT = 'Your Harbour Lane statement'

const base = devSeeds.updates
const at = (minutes: number) => new Date(Date.parse(base.now) - minutes * 60_000).toISOString()
const mail = (key: string, from: SeedMessage['from'], subject: string, html: string, minutes: number) =>
  ({
    key,
    mailboxes: ['inbox'],
    from,
    to: [base.seed.address],
    subject,
    text: `${subject}.`,
    html,
    sentAt: at(minutes),
  }) satisfies SeedMessage

/** Hana's schedule, as Outlook writes a person's mail: inline colors, a data table, a link and a signature. */
const PLAIN_HTML = [
  '<div style="font:14.5px/21px Arial,Helvetica,sans-serif;color:#222">',
  '<p>Hi Robin,</p>',
  '<p>Here is the schedule the printer sent this morning. The cover lock moved to <b>Thursday at noon</b>, a day later than we planned, so you have a little more time on the masthead.</p>',
  '<table style="border-collapse:collapse"><tr><th style="padding:6px 10px;border:1px solid #c8c8c8;background:#f2f2f2">Step</th><th style="padding:6px 10px;border:1px solid #c8c8c8;background:#f2f2f2">Date</th><th style="padding:6px 10px;border:1px solid #c8c8c8;background:#f2f2f2">Owner</th></tr>',
  '<tr><td style="padding:6px 10px;border:1px solid #c8c8c8">Final pages to printer</td><td style="padding:6px 10px;border:1px solid #c8c8c8">Wed, Nov 25</td><td style="padding:6px 10px;border:1px solid #c8c8c8">Priya</td></tr>',
  '<tr><td style="padding:6px 10px;border:1px solid #c8c8c8">Cover file locked</td><td style="padding:6px 10px;border:1px solid #c8c8c8">Thu, Nov 26, noon</td><td style="padding:6px 10px;border:1px solid #c8c8c8">Robin</td></tr></table>',
  `<p>The full quote is on <a href="https://printer.example/portal" style="color:#0563C1">the printer's portal</a> if you want the paper weights.</p>`,
  '<p>Thanks,<br>Hana</p>',
  '<div style="color:#555;font-size:13px"><b style="color:#222">Hana Sato</b><br>Production editor, Inkwell Press<br><span style="font-size:10.5px;color:#888">This message and its attachments are for the named recipients only.</span></div>',
  '</div>',
].join('')

/**
 * A machine's notice whose CSS tries the color variables by the name a sender might guess: it
 * sets one, which the core's own colors never read, and reads another, which the reader never
 * sets, so that text keeps the sender's own color in dark (`as-written`).
 */
const PROBE_HTML = [
  '<style>:root{--letterbox-color-0:#ff0000;--letterbox-color-1:#ff0000}</style>',
  '<p class="kept" style="color:#222222">Your settings are saved.</p>',
  '<p class="as-written" style="color:var(--letterbox-color-2, #333333)">Nothing else changed.</p>',
].join('')

const seed: DevSeed = {
  ...base,
  seed: {
    ...base.seed,
    messages: [
      ...base.seed.messages,
      mail('colors-plain', { name: 'Hana Sato', address: 'hana@inkwellpress.test' }, PLAIN, PLAIN_HTML, 50),
      {
        ...mail('colors-probe', { name: 'Notices', address: 'no-reply@notices.example' }, PROBE, PROBE_HTML, 60),
        headers: { autoSubmitted: 'auto-generated' },
      },
      mail(
        'colors-nowhere',
        { name: 'Nobody', address: '' },
        NOWHERE,
        '<p style="color:#222222">Who sent this?</p>',
        70,
      ),
    ],
  },
}

const switchOf = (page: Page, nth = -1) => opened(page, nth).locator('[data-field="colors-switch"]')

/** Chooses a scheme on the newest open message's switch, and waits until its frame shows it. */
async function choose(page: Page, scheme: 'dark' | 'original') {
  await switchOf(page).locator(`[data-scheme-option="${scheme}"]`).click()
  await page.locator(`[data-message="open"] iframe[title="Message"][data-scheme="${scheme}"]`).last().waitFor()
  await settled(page, NEWEST)
}

/** Waits until a frame's root carries the colors of its scheme: each palette entry (`data-palette` of them) dark, or none. */
const settled = (page: Page, where: Where) =>
  page.waitForFunction(({ nth, title }) => {
    const messages = document.querySelectorAll('[data-message="open"]')
    const frame = messages[nth < 0 ? messages.length + nth : nth]?.querySelector<HTMLIFrameElement>(
      `iframe[title="${title ?? 'Message'}"]`,
    )
    // Through the prototype's getter: a sender's `<form name="documentElement">` shadows the property.
    const doc = frame?.contentDocument
    const element = doc
      ? (Object.getOwnPropertyDescriptor(Document.prototype, 'documentElement')?.get?.call(doc) as HTMLElement | null)
      : null
    if (!frame || !element || doc?.readyState !== 'complete') return false
    const style = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'style')?.get?.call(
      element,
    ) as CSSStyleDeclaration
    const set = [...style].filter((name) => name.includes('-color-')).length
    const palette = Number(frame.getAttribute('data-palette'))
    return set === (frame.getAttribute('data-scheme') === 'dark' ? palette : 0)
  }, where)

/**
 * What a frame shows: its scheme and look, the custom properties on its root, and the colors of
 * the elements `selector` finds. Read through the platform's prototypes, as body-frame.ts does.
 */
const frameColors = (page: Page, where: Where, selector: string) =>
  page.evaluate(
    ({ nth, title, selector: wanted }) => {
      const messages = document.querySelectorAll('[data-message="open"]')
      const frame = messages[nth < 0 ? messages.length + nth : nth]?.querySelector<HTMLIFrameElement>(
        `iframe[title="${title ?? 'Message'}"]`,
      )
      const doc = frame?.contentDocument
      const view = doc?.defaultView
      if (!frame || !doc || !view) return null
      const top = Object.getOwnPropertyDescriptor(Document.prototype, 'documentElement')?.get?.call(doc) as HTMLElement
      const style = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'style')?.get?.call(
        top,
      ) as CSSStyleDeclaration
      return {
        scheme: frame.getAttribute('data-scheme'),
        look: frame.getAttribute('data-look'),
        properties: [...style],
        colors: [...Document.prototype.querySelectorAll.call(doc, wanted)].map(
          (element) => view.getComputedStyle(element).color,
        ),
        colorScheme: view.getComputedStyle(top).colorScheme,
      }
    },
    { ...where, selector },
  )

/** A computed CSS color as its four channels, alpha from 0 to 1. */
function rgba(css: string): readonly [number, number, number, number] {
  const [r = 0, g = 0, b = 0, a = 1] = (/\(([^)]*)\)/.exec(css)?.[1] ?? '')
    .split(/[\s,/]+/)
    .filter(Boolean)
    .map(Number)
  return [r, g, b, a]
}

/** `top` laid over the opaque `below`. */
const over = (top: readonly number[], below: readonly number[]) =>
  [0, 1, 2].map((channel) => (top[channel] ?? 0) * (top[3] ?? 1) + (below[channel] ?? 0) * (1 - (top[3] ?? 1)))

/** WCAG's relative luminance of an opaque color. */
function luminance(rgb: readonly number[]) {
  const [r = 0, g = 0, b = 0] = rgb.map((value) => {
    const unit = value / 255
    return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/**
 * The newest open message's text that reads under 4.5:1 on what it is painted on: its
 * ancestors' backgrounds laid over the reader, then its color over them, as WCAG reckons it.
 * Text the core leaves in the sender's own colors (`.as-written`, `.unpaired`) is left out.
 */
async function unreadable(page: Page): Promise<string[]> {
  const shown = await frameOf(page, NEWEST).evaluate((frame: HTMLIFrameElement) => {
    const doc = frame.contentDocument
    const view = doc?.defaultView
    if (!doc || !view) return []
    return [...Document.prototype.querySelectorAll.call(doc, 'body *')]
      .filter(
        (element) =>
          element.getClientRects().length > 0 &&
          element.closest('.as-written, .unpaired') === null &&
          [...element.childNodes].some(
            (node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim() !== '',
          ),
      )
      .map((element) => {
        const backgrounds: string[] = []
        for (let up: Element | null = element; up !== null; up = up.parentElement)
          backgrounds.unshift(view.getComputedStyle(up).backgroundColor)
        return {
          text: (element.textContent ?? '').trim().slice(0, 30),
          color: view.getComputedStyle(element).color,
          backgrounds,
        }
      })
  })
  return shown.flatMap(({ text, color, backgrounds }) => {
    const below = backgrounds.reduce<readonly number[]>(
      (under, background) => over(rgba(background), under),
      [27, 27, 30],
    )
    const [high = 0, low = 0] = [luminance(over(rgba(color), below)), luminance(below)].toSorted((x, y) => y - x)
    const ratio = (high + 0.05) / (low + 0.05)
    return ratio < 4.5 ? [`${text}: ${ratio.toFixed(2)}`] : []
  })
}

/** The colors of the issue's two accent lines, its essay heading and its button, in the frame. */
const ISSUE_PARTS = 'h1, div[style*="letter-spacing"], a[style*="border-radius"]'

/** The Long Read: dark by default, Original on a dimmed card, and the choice for every issue, across a reload. */
async function checkBranded(page: Page) {
  await nav(page, 'Updates').click()
  await senderRow(page, 'The Long Read').click()
  await page.locator('[data-field="open-subject"]', { hasText: ISSUE }).waitFor()
  await settled(page, NEWEST)
  const dark = await frameColors(page, NEWEST, ISSUE_PARTS)
  equal(
    [
      dark?.scheme,
      dark?.look,
      dark?.colorScheme,
      dark?.properties.every((name) => /^--letterbox-[0-9a-f]{32}-color-\d+$/.test(name)),
      dark?.colors,
      await switchOf(page).getAttribute('data-scheme'),
      await unreadable(page),
    ],
    [
      'dark',
      'branded',
      'dark',
      true,
      ['rgb(241, 122, 81)', 'rgb(213, 231, 228)', 'rgb(244, 239, 230)', 'rgb(241, 122, 81)'],
      'dark',
      [],
    ],
    'the issue opens dark: each color the core names set dark on the frame by the body prefix, its text at 4.5:1 or more on what it is painted on',
  )
  await capture(page, 'body-colors-branded-dark')
  await page.setViewportSize({ width: 640, height: 700 })
  await page.screenshot({ path: join(ARTIFACTS, 'body-colors-branded-dark-640.png'), animations: 'disabled' })
  await page.setViewportSize({ width: 1440, height: 900 })

  await choose(page, 'original')
  const original = await frameColors(page, NEWEST, ISSUE_PARTS)
  const card = await opened(page, -1)
    .locator('[data-field="original-card"]')
    .evaluate((element) => getComputedStyle(element).filter)
  equal(
    [original?.scheme, original?.colorScheme, original?.properties, original?.colors, card],
    [
      'original',
      'light',
      [],
      ['rgb(200, 85, 43)', 'rgb(29, 43, 41)', 'rgb(244, 239, 230)', 'rgb(200, 85, 43)'],
      'brightness(0.86) saturate(0.92)',
    ],
    'Original shows the sender’s own colors, with no variable set, on a card dimmed to 86%',
  )
  await capture(page, 'body-colors-branded-original')

  // The choice is the sender's: its older newsletter shows Original too, and a reload keeps it.
  await page.locator('[data-message="folded"]').filter({ hasText: OLDER }).first().click()
  await page.locator('[data-message="open"] iframe[data-scheme="original"]').first().waitFor()
  await page.reload()
  await nav(page, 'Updates').click()
  await senderRow(page, 'The Long Read').click()
  await page.locator('[data-field="open-subject"]', { hasText: ISSUE }).waitFor()
  await settled(page, NEWEST)
  equal(
    [(await frameColors(page, NEWEST, 'h1'))?.scheme, await switchOf(page).getAttribute('data-scheme')],
    ['original', 'original'],
    'after a reload the sender still shows Original',
  )
  await choose(page, 'dark')
  equal((await frameColors(page, NEWEST, 'h1'))?.colors, ['rgb(213, 231, 228)'], 'Dark again restyles it')
}

/** Hana's plain HTML: dark, in the reader's type and colors. */
async function checkPlain(page: Page) {
  await nav(page, 'Inbox').click()
  await open(page, PLAIN)
  await settled(page, NEWEST)
  const type = await frameOf(page, NEWEST).evaluate((frame: HTMLIFrameElement) => {
    const doc = frame.contentDocument
    const view = doc?.defaultView
    const body = doc?.body
    if (!doc || !view || !body) return null
    const p = Document.prototype.querySelector.call(doc, 'p')
    const th = Document.prototype.querySelector.call(doc, 'th')
    const link = Document.prototype.querySelector.call(doc, 'a')
    const style = (element: Element | null) => (element ? view.getComputedStyle(element) : null)
    return {
      text: [style(p)?.fontSize, style(p)?.lineHeight, style(p)?.color],
      head: [style(th)?.fontSize, style(th)?.color],
      link: style(link)?.color,
      // 62 characters of 16 px type, about 600 px.
      measure: Math.abs(Number.parseFloat(view.getComputedStyle(body).maxWidth) - 600) < 60,
    }
  })
  equal(
    [(await frameColors(page, NEWEST, 'p'))?.look, type, await unreadable(page)],
    [
      'simple',
      {
        text: ['16px', '26px', 'rgb(228, 228, 228)'],
        head: ['12px', 'rgb(163, 163, 163)'],
        link: 'rgb(122, 167, 247)',
        measure: true,
      },
      [],
    ],
    'a person’s plain HTML takes the reader’s type and colors: 16/26 prose at 62 characters, muted table heads and the reader’s link blue',
  )
  await capture(page, 'body-colors-plain-dark')
}

/** A sender's CSS cannot set or read the colors, and a message with no From address has no switch. */
async function checkProbeAndNowhere(page: Page) {
  await open(page, PROBE)
  await settled(page, NEWEST)
  equal(
    (await frameColors(page, NEWEST, 'p'))?.colors,
    ['rgb(229, 229, 229)', 'rgb(51, 51, 51)'],
    'the sender sets --letterbox-color-0 to red and the core’s colors ignore it, and the variable it reads is never set: the names carry the body’s prefix',
  )
  await open(page, NOWHERE)
  await page.locator('[data-message="open"] iframe[title="Message"]').last().waitFor()
  equal(
    [await switchOf(page).count(), await frameOf(page, NEWEST).getAttribute('data-scheme')],
    [0, 'dark'],
    'a message with no From address shows no switch, and stays dark',
  )
}

/** Harbour Lane's statement: the open quote's frame takes the message's scheme. */
async function checkQuote(page: Page) {
  await open(page, STATEMENT)
  await opened(page, -1).locator('[data-field="quote-line"]').click()
  await frameOf(page, { nth: -1, title: 'Quoted history' }).waitFor()
  const schemes = async () =>
    opened(page, -1)
      .locator('iframe')
      .evaluateAll((frames) => frames.map((frame) => frame.getAttribute('data-scheme')))
  const before = await schemes()
  await choose(page, 'original')
  await page.locator('[data-message="open"] iframe[title="Quoted history"][data-scheme="original"]').last().waitFor()
  equal(
    [before, await schemes()],
    [
      ['dark', 'dark'],
      ['original', 'original'],
    ],
    'the open quote’s frame takes the message’s scheme',
  )
  await choose(page, 'dark')
}

export async function checkColors(browser: Browser) {
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
  const session = await openPage(browser, server.url, 'trace-body-colors.zip', { deviceScaleFactor: 2 })
  const { page, errors, remote } = session
  try {
    await checkBranded(page)
    await checkPlain(page)
    await checkProbeAndNowhere(page)
    await checkQuote(page)
    equal(remote, [], 'the page never reached past 127.0.0.1')
    equal(appErrors(errors), [], 'the colors page logged no errors')
  } finally {
    await session.close()
    await server.close()
    await running.close()
    await stopChildren()
  }
}
