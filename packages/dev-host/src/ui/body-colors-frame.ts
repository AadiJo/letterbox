// The colors UI check's view of a message's frames (body-colors.ts): the switch, the scheme a
// frame shows and the colors in it, its text's contrast on what it is painted on, whether a new
// scheme kept the same frame, and a blocked image's label as the screen shows it. A frame holds
// the sender's markup, which can shadow the document's own properties (`<form
// name="documentElement">`), so every read of a frame's root goes through the platform's
// prototypes, as the reader itself does (apps/desktop/renderer/src/frame-dom.ts).

import type { Page } from 'playwright'
import { frameOf, NEWEST, opened, type Where } from './body-frame.ts'

/** The newest open message's open quote frame. */
export const QUOTED: Where = { nth: -1, title: 'Quoted history' }

export const switchOf = (page: Page, nth = -1) => opened(page, nth).locator('[data-field="colors-switch"]')

/** Chooses a scheme on the newest open message's switch, and waits until its frame shows it. */
export async function choose(page: Page, scheme: 'dark' | 'original') {
  await switchOf(page).locator(`[data-scheme-option="${scheme}"]`).click()
  await page.locator(`[data-message="open"] iframe[title="Message"][data-scheme="${scheme}"]`).last().waitFor()
  await settled(page, NEWEST)
}

/** Waits until a frame's root carries the colors of its scheme: each palette entry (`data-palette` of them) dark, or none. */
export const settled = (page: Page, where: Where) =>
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
export const frameColors = (page: Page, where: Where, selector: string) =>
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
export const over = (top: readonly number[], below: readonly number[]) =>
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
export async function unreadable(page: Page): Promise<string[]> {
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

/** Marks the newest open message's frame element, so a check can tell whether a later one is the same. */
export const markFrame = (page: Page) =>
  frameOf(page, NEWEST).evaluate((frame) => frame.setAttribute('data-check-mark', 'kept'))

/** True while the newest open message's frame is the element `markFrame` marked, and shows its whole document. */
export const sameFrame = (page: Page) =>
  frameOf(page, NEWEST).evaluate((frame: HTMLIFrameElement) => {
    const doc = frame.contentDocument
    const top = doc
      ? (Object.getOwnPropertyDescriptor(Document.prototype, 'documentElement')?.get?.call(doc) as HTMLElement | null)
      : null
    const height = top ? Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')?.get?.call(top) : 0
    return {
      kept: frame.getAttribute('data-check-mark') === 'kept',
      fits: frame.getBoundingClientRect().height > 0 && Math.abs(frame.getBoundingClientRect().height - height) <= 1,
    }
  })

/**
 * The contrast of the first blocked image's label on its line, as the screen shows it: taken
 * from a screenshot of the line, so the card's filter in Original counts. Its darkest pixel is
 * the label's, against the line's own color beside the mark.
 */
export async function placeholderContrast(page: Page) {
  const frame = frameOf(page, NEWEST)
  const place = await frame.boundingBox()
  const box = await frame.evaluate((element: HTMLIFrameElement) => {
    const doc = element.contentDocument
    const span = doc ? Document.prototype.querySelector.call(doc, 'span[data-letterbox-image]') : null
    const rect = span?.getBoundingClientRect()
    return rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null
  })
  if (!place || !box) return 0
  const shot = await page.screenshot({
    clip: { x: place.x + box.x, y: place.y + box.y, width: box.width, height: box.height },
    animations: 'disabled',
  })
  // Decoded on a blank page of its own, whose policy lets a data: image in.
  const blank = await page.context().newPage()
  try {
    return await blank.evaluate(async (data) => {
      const image = new Image()
      image.src = `data:image/png;base64,${data}`
      await image.decode()
      const canvas = document.createElement('canvas')
      canvas.width = image.width
      canvas.height = image.height
      const context = canvas.getContext('2d')
      if (!context) return 0
      context.drawImage(image, 0, 0)
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
      const shade = (index: number) => {
        const [r = 0, g = 0, b = 0] = [pixels[index], pixels[index + 1], pixels[index + 2]].map((value) => {
          const unit = (value ?? 0) / 255
          return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4
        })
        return 0.2126 * r + 0.7152 * g + 0.0722 * b
      }
      const background = shade((Math.floor(canvas.height / 2) * canvas.width + 6) * 4)
      let darkest = background
      for (let index = 0; index < pixels.length; index += 4) darkest = Math.min(darkest, shade(index))
      return (background + 0.05) / (darkest + 0.05)
    }, shot.toString('base64'))
  } finally {
    await blank.close()
  }
}

declare global {
  interface Window {
    /** Set by `watchUnstyled`: how many times a message frame showed before its scheme was set. */
    letterboxUnstyled?: { count: number; stop: () => void }
  }
}

/**
 * Starts counting, in the page, each time the newest open message's frame shows while its
 * document's root carries no scheme yet: at every change to the reader's tree, as when a frame
 * is put in, and at every animation frame. `unstyledShown` stops it and gives the count.
 */
export const watchUnstyled = (page: Page) =>
  page.evaluate(() => {
    const look = () => {
      const frames = [...document.querySelectorAll('[data-message="open"]')]
        .at(-1)
        ?.querySelectorAll<HTMLIFrameElement>('iframe[title="Message"]')
      for (const frame of frames ?? []) {
        const doc = frame.contentDocument
        const top = doc
          ? (Object.getOwnPropertyDescriptor(Document.prototype, 'documentElement')?.get?.call(doc) as Element | null)
          : null
        const shown = !frame.classList.contains('invisible') && frame.isConnected
        const unstyled = shown && !top?.hasAttribute('data-letterbox-scheme') && watching
        if (unstyled && window.letterboxUnstyled) window.letterboxUnstyled.count += 1
      }
    }
    let watching = true
    const observer = new MutationObserver(look)
    observer.observe(document.body, { subtree: true, childList: true, attributes: true })
    const tick = () => {
      look()
      if (watching) requestAnimationFrame(tick)
    }
    window.letterboxUnstyled = {
      count: 0,
      stop: () => {
        watching = false
        observer.disconnect()
      },
    }
    requestAnimationFrame(tick)
  })

/** Stops `watchUnstyled`, and gives how many times a frame showed before its scheme was set. */
export const unstyledShown = (page: Page) =>
  page.evaluate(() => {
    window.letterboxUnstyled?.stop()
    return window.letterboxUnstyled?.count ?? -1
  })
