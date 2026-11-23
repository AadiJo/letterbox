// The body UI check's view of the reader: an open message by its place, its images chip and
// menu, and what its frames hold. A frame holds the sender's markup, which can shadow the
// document's own methods (`<form name="querySelectorAll">`), so every read of a frame goes
// through the platform's prototypes, as the reader itself does (apps/desktop/renderer/src/frame-dom.ts).
// body.ts and body-quotes.ts use it.

import { join } from 'node:path'
import type { Locator, Page } from 'playwright'
import { ARTIFACTS, SIZES } from './record.ts'

/** An open message by its place among the open ones, -1 for the newest, and one of its frames. */
export type Where = { nth: number; title?: 'Message' | 'Quoted history' }

export const NEWEST: Where = { nth: -1 }

export const opened = (page: Page, nth: number) => page.locator('[data-message="open"]').nth(nth)
export const chipOf = (page: Page, nth = -1) => opened(page, nth).locator('[data-field="images-chip"]')
export const menu = (page: Page) => page.getByRole('menu', { name: 'Images' })
export const frameOf = (page: Page, where: Where) =>
  opened(page, where.nth).locator(`iframe[title="${where.title ?? 'Message'}"]`)

/**
 * Everything the check reads from one frame, through prototypes only: each placeholder (its
 * alt text, its label, its height), each image, the CSS images by the element that draws them,
 * a form's `background`, the text, how many hostile elements and quote blocks reached it, its
 * title, and whether the frame shows the whole document with nothing to scroll.
 */
export const readFrame = (page: Page, where: Where) =>
  page.evaluate(({ nth, title }) => {
    // oxlint-disable-next-line unicorn/consistent-function-scoping -- it runs in the page, which only sees what this function holds
    const get = <Value>(prototype: object, name: string, target: object): Value =>
      Object.getOwnPropertyDescriptor(prototype, name)?.get?.call(target)
    // oxlint-disable-next-line unicorn/consistent-function-scoping -- it runs in the page, which only sees what this function holds
    const all = (doc: Document, selector: string) => [...Document.prototype.querySelectorAll.call(doc, selector)]
    const messages = document.querySelectorAll('[data-message="open"]')
    const message = messages[nth < 0 ? messages.length + nth : nth]
    const frame = message?.querySelector<HTMLIFrameElement>(`iframe[title="${title ?? 'Message'}"]`)
    const doc = frame?.contentDocument
    const view = doc?.defaultView
    if (!frame || !doc || !view) return null
    const root = get<HTMLElement>(Document.prototype, 'documentElement', doc)
    const body = get<HTMLElement>(Document.prototype, 'body', doc)
    const background = (selector: string) =>
      all(doc, selector).map((element) => view.getComputedStyle(element).backgroundImage.slice(0, 26))
    return {
      placeholders: all(doc, 'span[data-letterbox-image]').map((span) => ({
        alt: span.textContent,
        label: view.getComputedStyle(span, '::after').content,
        height: span.getBoundingClientRect().height,
      })),
      images: all(doc, 'img').map((image) => ({
        alt: image.getAttribute('alt'),
        type: (image.getAttribute('src') ?? '').split(';')[0],
        loaded: image instanceof view.HTMLImageElement && image.complete && image.naturalWidth > 0,
      })),
      css: {
        // An image's variable (`<cssPrefix>image-i`), not a color's, which most inline styles now name.
        drawn: background('body [style*="var(--letterbox-"][style*="-image-"], .paper'),
        decoys: background('.decoy-plain, .decoy-escaped'),
      },
      formBackground: all(doc, 'form[background]').map((form) =>
        (Element.prototype.getAttribute.call(form, 'background') ?? '').slice(0, 14),
      ),
      text: (get<string>(HTMLElement.prototype, 'innerText', body) ?? '').trim().replace(/\s+/g, ' '),
      // The frame's own `<base target="_blank">` names no URL. One from the mail would.
      hostile: all(doc, 'link, base[href], iframe, script').length,
      quote: all(doc, '.gmail_quote, blockquote').length,
      // The color of each quote attribution, which a `<style>` in the new part sets.
      cite: all(doc, '.gmail_attr').map((element) => view.getComputedStyle(element).color),
      // The color of the quoted text, which two rules of the same weight set, the later one blue (dark, a light blue).
      tone: all(doc, '.quote-tone').map((element) => view.getComputedStyle(element).color),
      title: get<string>(Document.prototype, 'title', doc),
      fits: {
        frame: frame.getBoundingClientRect().height,
        document: get<number>(HTMLElement.prototype, 'offsetHeight', root),
        scrolls:
          get<number>(Element.prototype, 'scrollHeight', root) > get<number>(Element.prototype, 'clientHeight', root),
      },
    }
  }, where)

/** Waits until a frame holds `count` images, each loaded, and `placeholders` placeholders. */
export const waitImages = (page: Page, where: Where, count: number, placeholders = 0) =>
  page.waitForFunction(
    ({ nth, title, count: wanted, placeholders: left }) => {
      const messages = document.querySelectorAll('[data-message="open"]')
      const message = messages[nth < 0 ? messages.length + nth : nth]
      const doc = message?.querySelector<HTMLIFrameElement>(`iframe[title="${title ?? 'Message'}"]`)?.contentDocument
      if (!doc) return false
      const view = doc.defaultView
      const images = [...Document.prototype.querySelectorAll.call(doc, 'img')]
      const spans = Document.prototype.querySelectorAll.call(doc, 'span[data-letterbox-image]').length
      return (
        view !== null &&
        images.length === wanted &&
        spans === left &&
        images.every((image) => image instanceof view.HTMLImageElement && image.complete && image.naturalWidth > 0)
      )
    },
    { ...where, count, placeholders },
  )

/** The chip's look: what it says, its choice, and its colors. */
export const chipLooks = (chip: Locator) =>
  chip.evaluate((element) => ({
    text: element.textContent,
    images: element.getAttribute('data-images'),
    height: element.getBoundingClientRect().height,
    color: getComputedStyle(element).color,
    background: getComputedStyle(element).backgroundColor,
  }))

/** The open menu: its choices, their keys, and its note about trackers, if any. */
export const menuSays = (page: Page) =>
  menu(page).evaluate((element) => ({
    items: [...element.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent),
    note: element.querySelector('[data-field="tracker-note"]')?.textContent ?? null,
  }))

/** True while the element with focus is `chip`. */
export const focused = (chip: Locator) => chip.evaluate((element) => document.activeElement === element)

/** Takes the page at 1440×900 as `<name>.png` and at 1024×700 as `<name>-narrow.png`, then leaves it wide. */
export async function capture(page: Page, name: string) {
  await page.screenshot({ path: join(ARTIFACTS, `${name}.png`), animations: 'disabled' })
  await page.setViewportSize(SIZES.narrow)
  await page.screenshot({ path: join(ARTIFACTS, `${name}-narrow.png`), animations: 'disabled' })
  await page.setViewportSize(SIZES.wide)
}
