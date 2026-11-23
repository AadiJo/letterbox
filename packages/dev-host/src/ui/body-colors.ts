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
import {
  choose,
  unstyledShown,
  watchUnstyled,
  frameColors,
  markFrame,
  placeholderContrast,
  QUOTED,
  sameFrame,
  settled,
  switchOf,
  unreadable,
} from './body-colors-frame.ts'
import { chipOf, frameOf, NEWEST, opened } from './body-frame.ts'
import { appErrors, ARTIFACTS, capture, equal, openPage, type Relay, root } from './record.ts'
import { open } from './reply-page.ts'
import { nav, senderRow } from './updates-edges.ts'

const STATE = join(root, '.letterbox/ui-check-body-colors')

const ISSUE = 'Issue 212: the quiet web'
const OLDER = 'Five essays for the weekend'
const PLAIN = 'Print schedule for issue 12'
const PROBE = 'Your notice settings'
const NOWHERE = 'A note from nowhere'
const BLANK = 'A note from a blank sender'
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

/** A 1×1 PNG with nothing in it: a logo whose background shows through. */
const TRANSPARENT = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYGBgAAAABQABh6FO1AAAAABJRU5ErkJggg=='

/**
 * Hana's schedule, as Outlook writes a person's mail: inline colors, a data table, a link and a
 * signature with a transparent logo. Its `<body text>` sets the page's text, and its CSS asks for
 * a dark color scheme on the root, which the reader overrides in either scheme.
 */
const PLAIN_HTML = [
  '<body text="#660000"><style>:root{color-scheme:dark !important}</style>',
  '<div style="font:14.5px/21px Arial,Helvetica,sans-serif;color:#222">',
  '<p>Hi Robin,</p>',
  '<p>Here is the schedule the printer sent this morning. The cover lock moved to <b>Thursday at noon</b>, a day later than we planned, so you have a little more time on the masthead.</p>',
  '<table style="border-collapse:collapse"><tr><th style="padding:6px 10px;border:1px solid #c8c8c8;background:#f2f2f2">Step</th><th style="padding:6px 10px;border:1px solid #c8c8c8;background:#f2f2f2">Date</th><th style="padding:6px 10px;border:1px solid #c8c8c8;background:#f2f2f2">Owner</th></tr>',
  '<tr><td style="padding:6px 10px;border:1px solid #c8c8c8">Final pages to printer</td><td style="padding:6px 10px;border:1px solid #c8c8c8">Wed, Nov 25</td><td style="padding:6px 10px;border:1px solid #c8c8c8">Priya</td></tr>',
  '<tr><td style="padding:6px 10px;border:1px solid #c8c8c8">Cover file locked</td><td style="padding:6px 10px;border:1px solid #c8c8c8">Thu, Nov 26, noon</td><td style="padding:6px 10px;border:1px solid #c8c8c8">Robin</td></tr></table>',
  `<p>The full quote is on <a href="https://printer.example/portal" style="color:#0563C1">the printer's portal</a> if you want the paper weights.</p>`,
  '<p>Thanks,<br>Hana</p>',
  '<div style="color:#555;font-size:13px"><b style="color:#222">Hana Sato</b><br>Production editor, Inkwell Press<br>',
  `<img class="logo" alt="Inkwell Press" width="120" height="24" src="data:image/png;base64,${TRANSPARENT}"><br>`,
  '<span style="font-size:10.5px;color:#888">This message and its attachments are for the named recipients only.</span></div>',
  '</div>',
].join('')

/**
 * A machine's notice whose CSS tries the color variables by the name a sender might guess: it
 * sets one, which the core's own colors never read, and reads another, which the reader never
 * sets, so that text keeps the sender's own color in dark (`as-written`).
 */
const PROBE_HTML = [
  '<style>:root{--letterbox-color-0:#ff0000;--letterbox-color-1:#ff0000;color-scheme:light !important;transition:color-scheme 10s allow-discrete}</style>',
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
      // A From of U+0085 alone, white space to the core (Rust's `is_whitespace`) but not to JavaScript's `trim`.
      mail(
        'colors-blank',
        { name: 'Blank', address: '\u0085' },
        BLANK,
        '<p style="color:#222222">Who is this?</p>',
        80,
      ),
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

/** The colors of the issue's two accent lines, its essay heading and its button, in the frame. */
const ISSUE_PARTS = 'h1, div[style*="letter-spacing"], a[style*="border-radius"]'

/** The Long Read: dark by default, Original on a dimmed card, and the choice for every issue, across a reload. */
async function checkBranded(page: Page, relay: Relay) {
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
      dark?.properties
        .filter((name) => name.includes('-color-'))
        .every((name) => /^--letterbox-[0-9a-f]{32}-color-\d+$/.test(name)),
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

  // Blocked, Shown and Blocked again, with the core's two answers held and released together: the
  // Shown frame is put in and taken out again before it loads, and no frame shows unstyled.
  await watchUnstyled(page)
  const held = relay.pauseAfterPageSends('"set-images"')
  await page.evaluate((subject) => window.letterboxDev?.setImages(subject, ['message', 'blocked']), ISSUE)
  await held
  relay.resume()
  await page.evaluate(() => window.letterboxDev?.settle())
  await settled(page, NEWEST)
  equal(
    [await unstyledShown(page), await chipOf(page).getAttribute('data-images')],
    [0, 'blocked'],
    'images shown and blocked again before the new frame loads: no frame shows before its scheme is set',
  )

  await markFrame(page)
  await choose(page, 'original')
  const original = await frameColors(page, NEWEST, ISSUE_PARTS)
  const card = await opened(page, -1)
    .locator('[data-field="frame-card"]')
    .first()
    .evaluate((element) => getComputedStyle(element).filter)
  const contrast = await placeholderContrast(page)
  equal(
    [
      original?.scheme,
      original?.colorScheme,
      original?.properties.filter((name) => name.includes('-color-')),
      original?.colors,
      card,
      await sameFrame(page),
      contrast >= 4.5 ? 'at least 4.5:1' : contrast.toFixed(2),
    ],
    [
      'original',
      'light',
      [],
      ['rgb(200, 85, 43)', 'rgb(29, 43, 41)', 'rgb(244, 239, 230)', 'rgb(200, 85, 43)'],
      'brightness(0.86) saturate(0.92)',
      { kept: true, fits: true },
      'at least 4.5:1',
    ],
    'Original shows the sender’s own colors, with no variable set, on a card dimmed to 86%, in the same frame as tall as its document, its image labels at 4.5:1 through the dimming',
  )
  await capture(page, 'body-colors-branded-original')

  // The choice is the sender's: its older newsletter shows Original too, and a reload keeps it.
  await nav(page, 'Inbox').click()
  await open(page, OLDER)
  await settled(page, NEWEST)
  const older = await frameColors(page, NEWEST, 'h1, #probe')
  equal(
    [older?.colors, older?.colorScheme, await switchOf(page).getAttribute('data-scheme')],
    [['rgb(29, 29, 31)', 'rgb(29, 29, 31)'], 'light', 'original'],
    'the sender’s older newsletter shows its own colors too: its text the light page’s near black',
  )
  await page.reload()
  await nav(page, 'Updates').click()
  await senderRow(page, 'The Long Read').click()
  await page.locator('[data-field="open-subject"]', { hasText: ISSUE }).waitFor()
  await settled(page, NEWEST)
  equal(
    [(await frameColors(page, NEWEST, 'h1'))?.colors, await switchOf(page).getAttribute('data-scheme')],
    [['rgb(29, 43, 41)'], 'original'],
    'after a reload the sender still shows Original',
  )

  // The switch is a radio group: the chosen segment holds the tab stop, and ↓ and ↑ choose in it
  // without moving the reader to another conversation.
  const radios = () =>
    switchOf(page)
      .locator('[role="radio"]')
      .evaluateAll((all) => all.map((radio) => [radio.getAttribute('tabindex'), document.activeElement === radio]))
  await switchOf(page).locator('[data-scheme-option="original"]').focus()
  const before = await radios()
  await page.keyboard.press('ArrowDown')
  await page.locator('[data-message="open"] iframe[title="Message"][data-scheme="dark"]').last().waitFor()
  await settled(page, NEWEST)
  equal(
    [
      before,
      await radios(),
      await page.locator('[data-field="open-subject"]').textContent(),
      (await frameColors(page, NEWEST, 'h1'))?.colors,
    ],
    [
      [
        ['-1', false],
        ['0', true],
      ],
      [
        ['0', true],
        ['-1', false],
      ],
      ISSUE,
      ['rgb(213, 231, 228)'],
    ],
    '↓ on the switch chooses Dark and takes the focus and the tab stop with it, and the reader stays on the issue',
  )

  // Two quick presses step twice, from the focused segment: Original, then Dark again. The core's
  // answers wait at the relay until both are sent, so the second press has no report to go by.
  const sent = relay.fromPage().length
  const holding = relay.pauseAfterPageSends('"set-colors"')
  await page.keyboard.press('ArrowDown')
  await holding
  await page.keyboard.press('ArrowDown')
  relay.resume()
  await page.evaluate(() => window.letterboxDev?.settle())
  await page.locator('[data-message="open"] iframe[title="Message"][data-scheme="dark"]').last().waitFor()
  await settled(page, NEWEST)
  equal(
    [
      relay
        .fromPage()
        .slice(sent)
        .filter((text) => text.includes('"set-colors"'))
        .map((text) => (JSON.parse(text) as { command: { scheme: string } }).command.scheme),
      await radios(),
      (await frameColors(page, NEWEST, 'h1'))?.colors,
    ],
    [
      ['original', 'dark'],
      [
        ['0', true],
        ['-1', false],
      ],
      ['rgb(213, 231, 228)'],
    ],
    'two quick ↓ presses choose Original, then Dark, each from the focused segment, and the last one stands',
  )
}

/** Hana's plain HTML: dark, in the reader's type and colors; Original, her own page text. */
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
    const logo = Document.prototype.querySelector.call(doc, 'img.logo')
    const style = (element: Element | null) => (element ? view.getComputedStyle(element) : null)
    return {
      text: [style(p)?.fontSize, style(p)?.lineHeight, style(p)?.color],
      head: [style(th)?.fontSize, style(th)?.color],
      link: style(link)?.color,
      logo: style(logo)?.backgroundColor,
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
        logo: 'rgb(233, 231, 225)',
        measure: true,
      },
      [],
    ],
    'a person’s plain HTML takes the reader’s type and colors: 16/26 prose at 62 characters, muted table heads, the reader’s link blue, and a light plate behind a transparent logo',
  )
  await capture(page, 'body-colors-plain-dark')

  await choose(page, 'original')
  equal(
    [(await frameColors(page, NEWEST, 'body'))?.colors, (await frameColors(page, NEWEST, 'body'))?.colorScheme],
    [['rgb(102, 0, 0)'], 'light'],
    'in her own colors, her <body text> colors the page over the frame’s default, and the frame stays light though her CSS asks for dark',
  )
  await choose(page, 'dark')
}

/**
 * A sender's CSS cannot set or read the colors, or turn the frame's color scheme, a color that is
 * not hex never reaches the frame, and a message with no From address, blank to the core, has no switch.
 */
async function checkProbeAndNowhere(page: Page, relay: Relay) {
  await open(page, PROBE)
  await settled(page, NEWEST)
  const probe = await frameColors(page, NEWEST, 'p')
  equal(
    [probe?.colors, probe?.colorScheme],
    [['rgb(229, 229, 229)', 'rgb(51, 51, 51)'], 'dark'],
    'the sender sets --letterbox-color-0 to red and the core’s colors ignore it, the variable it reads is never set, and its light color scheme loses to the reader’s',
  )
  // Its CSS also eases the root's color scheme over ten seconds: the reader's change shows at once.
  await choose(page, 'original')
  const eased = (await frameColors(page, NEWEST, 'p'))?.colorScheme
  await choose(page, 'dark')
  equal(
    [eased, (await frameColors(page, NEWEST, 'p'))?.colorScheme],
    ['light', 'dark'],
    'a transition the sender puts on the root’s color scheme is turned off: each new scheme shows at once',
  )

  // The same notice again, with every dark value the core sent turned into a url on its way to the page.
  await open(page, PLAIN)
  relay.rewriteToPage((message) =>
    message.replaceAll(/"dark":"#[0-9a-f]{6}"/g, '"dark":"url(https://x.example/a.png)"'),
  )
  await open(page, PROBE)
  await page.waitForFunction(() => {
    const frame = [...document.querySelectorAll('[data-message="open"]')]
      .at(-1)
      ?.querySelector<HTMLIFrameElement>('iframe[title="Message"]')
    return (
      frame !== undefined &&
      frame !== null &&
      !frame.classList.contains('invisible') &&
      frame.contentDocument?.readyState === 'complete'
    )
  })
  const forged = await frameColors(page, NEWEST, 'p.kept')
  relay.rewriteToPage(undefined)
  equal(
    [forged?.properties.filter((name) => name.includes('-color-')), forged?.colors],
    [[], ['rgb(34, 34, 34)']],
    'a dark value that is not a hex color is never written, so the sender’s own color shows',
  )

  // oxlint-disable-next-line no-await-in-loop -- each message opens in the reader in turn
  for (const subject of [NOWHERE, BLANK]) await noSwitch(page, subject)
}

/** Opens `subject`, which must show no switch and stay dark: its From has no address, or one the core reads as blank. */
async function noSwitch(page: Page, subject: string) {
  await open(page, subject)
  await page.locator('[data-message="open"] iframe[title="Message"]').last().waitFor()
  equal(
    [await switchOf(page).count(), await frameOf(page, NEWEST).getAttribute('data-scheme')],
    [0, 'dark'],
    `${subject}: no From address, or one the core reads as blank (U+0085), shows no switch, and stays dark`,
  )
}

/** Harbour Lane's statement: the open quote's frame takes the message's scheme. */
async function checkQuote(page: Page) {
  await open(page, STATEMENT)
  await opened(page, -1).locator('[data-field="quote-line"]').click()
  await frameOf(page, QUOTED).waitFor()
  await settled(page, QUOTED)
  const looks = async () => ({
    message: await frameColors(page, NEWEST, 'body'),
    quote: await frameColors(page, QUOTED, '.gmail_attr'),
  })
  const before = await looks()
  await choose(page, 'original')
  await settled(page, QUOTED)
  const after = await looks()
  equal(
    [
      [before.message?.colors, before.message?.colorScheme, before.quote?.colors, before.quote?.colorScheme],
      [after.message?.colors, after.message?.colorScheme, after.quote?.colors, after.quote?.colorScheme],
    ],
    [
      [['rgb(228, 228, 228)'], 'dark', ['rgb(255, 186, 181)'], 'dark'],
      [['rgb(29, 29, 31)'], 'light', ['rgb(120, 40, 40)'], 'light'],
    ],
    'the open quote’s frame takes the message’s scheme: both frames’ text in the reader’s, then the light page’s, and the attribution dark, then in the sender’s own red',
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
  const { page, relay, errors, remote } = session
  try {
    await checkBranded(page, relay)
    await checkPlain(page)
    await checkProbeAndNowhere(page, relay)
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
