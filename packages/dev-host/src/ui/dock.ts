// The reply dock as the user writes in it, for the reply check (reply.ts): the editor's
// handles, typing a draft as a user would, and the checks that the dock matches the design.
// The draft reads like the body it answers, the conversation's end stays in view above it,
// and Send stays in view in a small window.

import type { Page } from 'playwright'
import { equal } from './record.ts'

export const dock = (page: Page) => page.locator('section[aria-label="Reply"]')
export const body = (page: Page) => dock(page).getByRole('textbox', { name: 'Message' })

/** The draft's text as the editor shows it: its paragraphs, a blank line between each two. */
export const draftText = (page: Page) =>
  body(page).evaluate((element) => (element instanceof HTMLElement ? element.innerText : ''))

/** Replaces the draft's text by typing it as a user would: Enter between paragraphs, Shift+Enter between lines. */
export async function write(page: Page, text: string) {
  await body(page).focus()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.press('Backspace')
  for (const [index, paragraph] of text.split('\n\n').entries()) {
    // oxlint-disable-next-line no-await-in-loop -- keys reach the editor one at a time, in order
    if (index > 0) await page.keyboard.press('Enter')
    for (const [at, line] of paragraph.split('\n').entries()) {
      // oxlint-disable-next-line no-await-in-loop -- keys reach the editor one at a time, in order
      if (at > 0) await page.keyboard.press('Shift+Enter')
      // oxlint-disable-next-line no-await-in-loop -- keys reach the editor one at a time, in order
      await page.keyboard.type(line)
    }
  }
}

/** Where `selector`'s first match is, with its width, or a failure naming it. */
async function box(page: Page, selector: string) {
  const found = await page.locator(selector).first().boundingBox()
  if (!found) throw new Error(`the page shows no ${selector}`)
  return {
    left: found.x,
    top: found.y,
    right: found.x + found.width,
    bottom: found.y + found.height,
    width: found.width,
  }
}

/**
 * With a draft of three paragraphs open under Notes from Thursday: it reads like the body it
 * answers, the divider under the last message stays 24 px above the dock, and the pinned
 * subject covers what scrolls under it, with the fade starting at its edge.
 */
export async function checkDraftReadsLikeBody(page: Page) {
  // The draft reads like the body it answers: 16/26 paragraphs 16 px apart, on the body's left edge and measure.
  const paragraphs = await body(page).evaluate((element) =>
    [...element.querySelectorAll(':scope > p')].map((paragraph) => {
      const { top, bottom, left, width } = paragraph.getBoundingClientRect()
      const style = getComputedStyle(paragraph)
      return { top, bottom, left, width, type: `${style.fontSize}/${style.lineHeight}` }
    }),
  )
  const received = await box(page, '[data-message="open"] [data-field="body"] p')
  equal(
    {
      count: paragraphs.length,
      gaps: paragraphs.slice(1).map((paragraph, index) => Math.round(paragraph.top - (paragraphs[index]?.bottom ?? 0))),
      type: [...new Set(paragraphs.map((paragraph) => paragraph.type))],
      left: paragraphs.every((paragraph) => Math.abs(paragraph.left - received.left) < 0.5),
      measure: paragraphs.every((paragraph) => paragraph.width <= received.width + 0.5),
    },
    { count: 3, gaps: [16, 16], type: ['16px/26px'], left: true, measure: true },
    "the draft is three 16/26 paragraphs, 16 px apart, on the body's edge and measure",
  )

  // While writing, the conversation's end stays in view: the divider under the last message, 24 px above the dock.
  const lastMessage = await box(page, '[data-message="open"]:last-of-type')
  const dockTop = (await box(page, 'section[aria-label="Reply"]')).top
  equal(Math.round(dockTop - lastMessage.bottom), 24, 'the divider under the last message sits 24 px above the dock')

  // The pinned subject hides what scrolls under it, and the fade starts where it ends.
  const band = await box(page, '[data-field="subject-band"]')
  const fade = await box(page, '[data-field="scroll-fade"]')
  const under = await page.evaluate(
    ({ left, right, middle }) =>
      [left + 1, (left + right) / 2, right - 2].map((x) =>
        Boolean(document.elementFromPoint(x, middle)?.closest('[data-field="subject-band"]')),
      ),
    { left: band.left, right: band.right, middle: (band.top + band.bottom) / 2 },
  )
  equal(
    [under, Math.round(fade.top - band.bottom)],
    [[true, true, true], 0],
    'the pinned subject covers what scrolls under it, and the fade starts at its edge',
  )
}

/** With Reply all open: Send stays in view at 1024×700, and shortcuts name their key one way. */
export async function checkDockFits(page: Page) {
  // In a 1024×700 window, To, Cc and Bcc fill the dock, and Send still shows: the lines scroll instead.
  await page.setViewportSize({ width: 1024, height: 700 })
  const send = await box(page, 'section[aria-label="Reply"] footer button:has-text("Send")')
  const shown = await box(page, 'section[aria-label="Reply"]')
  equal(
    send.top >= shown.top && send.bottom <= Math.min(shown.bottom, 700),
    true,
    `at 1024×700 with Reply all, Send stays in view (${Math.round(send.top)} to ${Math.round(send.bottom)} px)`,
  )
  await page.setViewportSize({ width: 1440, height: 900 })
  // Every shortcut names the platform's key one way: Ctrl here, on Linux.
  equal(
    [
      await page.locator('form[role="search"] kbd').textContent(),
      await page.locator('section[aria-label="Reply"] footer kbd').first().textContent(),
    ],
    ['Ctrl K', 'Ctrl ↵'],
    'search and Send name their shortcuts the same way',
  )
}
