// The colour pass's output as a browser paints it (crates/core/src/body/paint.rs), in
// Playwright's Chromium. The core's html goes into a frame document like the reader's (the same
// policy, nothing loads), once as the sender's own colors and once dark, with each palette entry
// set on the root as a UI sets it. It checks what only a browser can tell: a value a browser
// drops still leaves the declaration before it in effect, a color attribute applies only where a
// browser honours it and loses to every rule of the sender's, and dark text reads on the
// background it is painted on, the sender's own backgrounds too.

import type { Page } from 'playwright'
import type { Seed } from '@letterbox/sim-provider/contract'
import type { Swatch } from '@letterbox/protocol'
import { ME, openThread, PASSWORD, start, thread } from '../src/fixtures.ts'
import { scenario } from '../src/scenario.ts'
import { ANA, HANA, HANA_HTML, INVALID_HTML, LUMEN, LUMEN_HTML, mail, PAIRS_HTML } from '../src/colored-mail.ts'

/** The reader's frame policy (apps/desktop/renderer/src/Body.tsx): nothing in the html loads. */
const POLICY = "default-src 'none'; img-src data: cid:; font-src data:; style-src 'unsafe-inline'; base-uri 'none'"

/**
 * The frame's own defaults: as shipped for the sender's colors, and for dark the reader's
 * background, text and links, which a UI gives the frame for what the html leaves unset. They
 * sit in a cascade layer before the html's, so every rule of the sender's and the core's color
 * attribute rules win over them.
 */
const DEFAULTS = {
  original: '@layer{html{color-scheme:light}body{margin:0;padding:16px;color:#1d1d1f}}',
  dark: '@layer{html{color-scheme:dark;background:#1b1b1e}body{margin:0;padding:16px;color:#e4e4e4}a:link{color:#7aa7f7}}',
}

type Scheme = keyof typeof DEFAULTS

const seed = (): Seed => ({
  address: ME,
  password: PASSWORD,
  mailboxes: [{ key: 'inbox', name: 'Inbox', role: 'inbox' }],
  messages: [
    mail('lumen', LUMEN, 'Issue 212', LUMEN_HTML, '2025-12-08T09:00:00.000Z'),
    mail('hana', HANA, 'Print schedule', HANA_HTML, '2025-12-08T10:00:00.000Z'),
    mail('invalid', ANA, 'Invalid colors', INVALID_HTML, '2025-12-10T09:00:00.000Z'),
    mail('pairs', ANA, 'Pairs', PAIRS_HTML, '2025-12-10T10:00:00.000Z'),
  ],
})

/** One body as the core passed it on: its html, its palette and its custom property prefix. */
type Painted = { html: string; palette: Swatch[]; prefix: string }

/** Shows a body in `page` in a scheme: for dark, each swatch's value on the root, by the body's prefix. */
async function paint(page: Page, { html, palette, prefix }: Painted, scheme: Scheme) {
  const frame = `<!doctype html><meta http-equiv="Content-Security-Policy" content="${POLICY}"><meta charset="utf-8"><style>${DEFAULTS[scheme]}</style>${html}`
  await page.setContent(frame)
  if (scheme === 'dark')
    await page.evaluate(
      ({ values, names }) => {
        values.forEach((value, index) => document.documentElement.style.setProperty(`${names}color-${index}`, value))
      },
      { values: palette.map((swatch) => swatch.dark), names: prefix },
    )
}

/** The computed `property` of each element `selector` finds. */
const computed = (
  page: Page,
  selector: string,
  property: 'color' | 'backgroundColor' | 'outlineColor' | 'borderTopColor',
) => page.$$eval(selector, (elements, name) => elements.map((element) => getComputedStyle(element)[name]), property)

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
 * Each element whose own text is shown with a contrast under 4.5:1 on what it is painted on: its
 * ancestors' backgrounds laid over the canvas, then its color over them, as WCAG reckons it. Two
 * kinds are left out, since the core promises nothing for them: text in an `.unpaired` element,
 * whose rule has a background the core cannot read that could win, so it reads that text on the
 * reader, and an `.as-written` color, a value the core cannot read (a `var()`), which keeps the
 * sender's color in dark.
 */
async function unreadable(page: Page): Promise<string[]> {
  const shown = await page.evaluate(() =>
    [...document.body.querySelectorAll('*')]
      .filter(
        (element) =>
          element.getClientRects().length > 0 &&
          element.closest('.unpaired, .as-written') === null &&
          [...element.childNodes].some(
            (node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim() !== '',
          ),
      )
      .map((element) => {
        const backgrounds: string[] = []
        for (let at: Element | null = element; at !== null; at = at.parentElement)
          backgrounds.unshift(getComputedStyle(at).backgroundColor)
        return {
          text: (element.textContent ?? '').trim().slice(0, 30),
          color: getComputedStyle(element).color,
          backgrounds,
        }
      }),
  )
  return shown.flatMap(({ text, color, backgrounds }) => {
    const below = backgrounds.reduce<readonly number[]>(
      (under, background) => over(rgba(background), under),
      [255, 255, 255],
    )
    const [high = 0, low = 0] = [luminance(over(rgba(color), below)), luminance(below)].toSorted((x, y) => y - x)
    const ratio = (high + 0.05) / (low + 0.05)
    return ratio < 4.5 ? [`${text}: ${ratio.toFixed(2)}`] : []
  })
}

scenario(
  'the colour pass paints as a browser reads it, so dropped values stay dropped, attributes rank last, and dark text reads',
  async (t) => {
    const { core } = await start(t, seed())
    const bodies: Record<string, Painted> = {}
    for (const subject of ['Issue 212', 'Print schedule', 'Invalid colors', 'Pairs']) {
      const open = await openThread(core, (await thread(core, subject)).id)
      const body = open.latest()?.messages[0]?.body
      if (body?.state !== 'ready' || body.html === null || body.colors === null)
        throw new Error(`${subject} has no html`)
      bodies[subject] = { html: body.html, palette: body.colors.palette, prefix: body.cssPrefix }
      open.close()
    }
    const body = (subject: string) => {
      const found = bodies[subject]
      if (found === undefined) throw new Error(`no body for ${subject}`)
      return found
    }

    const page = await (await t.browser()).newPage()
    const invalid = body('Invalid colors')
    await paint(page, invalid, 'original')
    const originalBlue = await computed(page, 'p.kept', 'color')
    const originalNavy = await computed(page, 'p.shorthand', 'backgroundColor')
    const originalOutline = await computed(page, 'p.outlined', 'outlineColor')
    const originalBorders = await computed(page, 'p.bordered', 'borderTopColor')
    const originalNested = await computed(page, 'p.outer, p.outer-media', 'color')
    await paint(page, invalid, 'dark')
    t.equal(
      [originalBlue, await computed(page, 'p.kept', 'color')],
      [Array(4).fill('rgb(5, 99, 193)'), Array(4).fill('rgb(132, 186, 255)')],
      "a value a browser drops, past a no-break space, a commented var() or a hash token too, leaves the blue before it in effect, in the sender's colors and in dark",
    )
    t.equal(
      [originalOutline, await computed(page, 'p.outlined', 'outlineColor')],
      [['rgb(204, 0, 0)'], ['rgb(220, 35, 25)']],
      'an outline a browser drops (hidden is no outline style) leaves the red before it in effect, in both schemes',
    )
    t.equal(
      [originalBorders, await computed(page, 'p.bordered', 'borderTopColor')],
      [Array(2).fill('rgb(204, 0, 0)'), Array(2).fill('rgb(220, 35, 25)')],
      'a border width a browser drops (-1e-50px, or 1e-50 with no unit) leaves the red border before it in effect, in both schemes',
    )
    t.equal(
      [originalNested, await computed(page, 'p.outer, p.outer-media', 'color')],
      [
        ['rgb(0, 0, 255)', 'rgb(255, 0, 0)'],
        ['rgb(0, 0, 255)', 'rgb(255, 0, 0)'],
      ],
      'rules nested in a style rule paint as the sender wrote them, in both schemes: the core reads and wraps nothing in them',
    )
    t.equal(
      [originalNavy, await computed(page, 'p.shorthand', 'backgroundColor')],
      [['rgb(0, 0, 56)'], ['rgb(46, 74, 135)']],
      'a shorthand a browser drops leaves the navy before it in effect, in both schemes',
    )

    const pairs = body('Pairs')
    await paint(page, pairs, 'original')
    const originalUnpaired = await computed(page, 'td.unpaired', 'backgroundColor')
    t.equal(
      [await computed(page, 'div', 'backgroundColor'), await computed(page, 'table[bgcolor] td', 'backgroundColor')],
      [['rgba(0, 0, 0, 0)'], ['rgb(0, 0, 56)', 'rgb(0, 255, 0)']],
      "in the sender's colors a div's bgcolor stays ignored, a cell's applies, and a rule in the sender's own layer beats it",
    )

    await paint(page, pairs, 'dark')
    t.equal(
      [originalUnpaired, await computed(page, 'td.unpaired', 'backgroundColor')],
      [
        ['rgb(0, 0, 56)', 'rgb(0, 0, 56)', 'rgb(0, 0, 56)', 'rgba(0, 0, 0, 0)'],
        ['rgb(46, 74, 135)', 'rgb(46, 74, 135)', 'rgb(46, 74, 135)', 'rgba(0, 0, 0, 0)'],
      ],
      "a background a browser drops leaves the navy before it in effect, and inherit takes the row's, in both schemes",
    )

    const unread: Record<string, string[]> = {}
    for (const subject of ['Issue 212', 'Print schedule', 'Invalid colors', 'Pairs']) {
      await paint(page, body(subject), 'dark')
      unread[subject] = await unreadable(page)
    }
    t.equal(
      unread,
      { 'Issue 212': [], 'Print schedule': [], 'Invalid colors': [], Pairs: [] },
      "in dark, every shown text reads at 4.5:1 or more on what it is painted on, the sender's backgrounds too",
    )
  },
  ['folders'],
)
