// The reply dock as the user writes in it, for the reply check (reply.ts): the editor's
// handles, typing a draft as a user would, and the checks that the dock matches the design.
// The draft reads like the body it answers, the conversation's end stays in view above it,
// Send stays in view in a small window, the dock's edges line up, and a draft comes back
// exactly as written after it is folded, left, or sent and taken back.

import type { Page } from 'playwright'
import { equal } from './record.ts'
import { body, dock, open, toast } from './reply-page.ts'

/** The draft's text, exactly as the editor holds it. */
export const draftText = (page: Page) => body(page).inputValue()

/** Replaces the draft's text, as typing would. */
export const write = (page: Page, text: string) => body(page).fill(text)

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
 * With a draft open under Notes from Thursday: it reads like the body it answers, the divider
 * under the last message stays 24 px above the dock, and the pinned subject covers what
 * scrolls under it, with the scrolled edge starting at its edge.
 */
export async function checkDraftReadsLikeBody(page: Page) {
  // The draft reads like the body it answers: 16/26 type, its text on the body's left edge, no wider than its measure.
  const draft = await body(page).evaluate((field) => {
    const style = getComputedStyle(field)
    const { left, width } = field.getBoundingClientRect()
    const [padLeft, padRight] = [Number.parseFloat(style.paddingLeft), Number.parseFloat(style.paddingRight)]
    return { type: `${style.fontSize}/${style.lineHeight}`, left: left + padLeft, width: width - padLeft - padRight }
  })
  const received = await box(page, '[data-message="open"] [data-field="body"] p')
  equal(
    [draft.type, Math.abs(draft.left - received.left) < 0.5, draft.width <= received.width + 0.5],
    ['16px/26px', true, true],
    `the draft is 16/26, on the body's edge, no wider than its measure (${Math.round(draft.width)} of ${Math.round(received.width)} px)`,
  )

  // While writing, the conversation's end stays in view: the divider under the last message, 24 px above the dock.
  const lastMessage = await box(page, '[data-message="open"]:last-of-type')
  const dockTop = (await box(page, 'section[aria-label="Reply"]')).top
  equal(Math.round(dockTop - lastMessage.bottom), 24, 'the divider under the last message sits 24 px above the dock')

  // The pinned subject hides what scrolls under it, and the scrolled edge starts where it ends.
  const band = await box(page, '[data-field="subject-band"]')
  const edge = await box(page, '[data-field="scroll-edge"]')
  const under = await page.evaluate(
    ({ left, right, middle }) =>
      [left + 1, (left + right) / 2, right - 2].map((x) =>
        Boolean(document.elementFromPoint(x, middle)?.closest('[data-field="subject-band"]')),
      ),
    { left: band.left, right: band.right, middle: (band.top + band.bottom) / 2 },
  )
  equal(
    [under, Math.round(edge.top - band.bottom)],
    [[true, true, true], 0],
    'the pinned subject covers what scrolls under it, and the hairline starts at its edge',
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

/**
 * With a draft open to one person: "To" sits 10 px before its chip, "Cc Bcc" and Discard's icon
 * end where the To line's divider ends, and Minimize's tooltip names Esc above it.
 */
export async function checkDockEdges(page: Page) {
  const edges = await dock(page).evaluate((section) => {
    const line = section.querySelector('[data-address-line="to"]')
    const label = line?.querySelector('label')
    const chip = line?.querySelector('[data-chip]')
    const extra = [...section.querySelectorAll('button')].find((button) => button.textContent?.startsWith('Cc'))
    const trash = section.querySelector('button[aria-label="Discard"] svg')
    if (!line || !label || !chip || !extra?.firstChild || !trash) throw new Error('the dock lacks a part to measure')
    const text = document.createRange()
    text.selectNodeContents(extra)
    const end = line.getBoundingClientRect().right
    return {
      toGap: Math.round(chip.getBoundingClientRect().left - label.getBoundingClientRect().right),
      extra: Math.round(text.getBoundingClientRect().right - end),
      trash: Math.round(trash.getBoundingClientRect().right - end),
    }
  })
  equal(
    edges,
    { toGap: 10, extra: 0, trash: 0 },
    '"To" sits 10 px from its chip, and Cc Bcc and Discard end on the divider',
  )
  const minimize = dock(page).getByRole('button', { name: 'Minimize' })
  await minimize.hover()
  const tip = page.locator('[role="tooltip"]:visible')
  const [tipBox, buttonBox] = [await tip.boundingBox(), await minimize.boundingBox()]
  if (!tipBox || !buttonBox) throw new Error('hovering Minimize shows no tooltip')
  equal(
    [await tip.textContent(), Math.round(buttonBox.y - (tipBox.y + tipBox.height))],
    ['MinimizeEsc', 6],
    'Minimize has the standard tooltip, with Esc, above it',
  )
  await page.mouse.move(0, 0)
}

/** Drafts a textarea must keep exactly: blank lines in a row, and a newline at the end. */
const KEPT = ['First line.\n\n\n\nAfter two blank lines.', 'Ends with a newline\n']
/** Pasted text with line breaks and blank lines, after what was typed. */
const PASTED = 'Pasted one\nPasted two\n\n\nPasted four'

/**
 * In `subject`, with nothing sent yet and the core holding sends, each draft comes back exactly
 * as written after Minimize and R, a trip to `other` and back, and Send then Undo. A paste
 * keeps its line breaks, and Ctrl+Z after it brings back what was there before.
 */
export async function checkDraftFidelity(page: Page, subject: string, other: string) {
  const roundTrip = async (text: string, what: string) => {
    await page.keyboard.press('Escape')
    await page.keyboard.press('r')
    equal(await draftText(page), text, `${what}: kept through Minimize and R`)
    await open(page, other)
    await open(page, subject)
    equal(await draftText(page), text, `${what}: kept through a trip to another conversation`)
    await body(page).focus()
    await page.keyboard.press('ControlOrMeta+Enter')
    await toast(page).getByRole('button', { name: /^Undo/ }).click()
    await dock(page).getByRole('button', { name: /^Send/ }).waitFor()
    await page.locator('[data-message="open"][data-delivery="held"]').waitFor({ state: 'detached' })
    equal(await draftText(page), text, `${what}: kept through Send and Undo`)
  }
  await open(page, subject)
  await page.keyboard.press('r')
  await dock(page).waitFor()
  for (const [index, text] of KEPT.entries()) {
    // oxlint-disable-next-line no-await-in-loop -- one draft at a time, in the one editor
    await write(page, text)
    // oxlint-disable-next-line no-await-in-loop -- one draft at a time, in the one editor
    await roundTrip(text, index === 0 ? 'blank lines in a row' : 'a newline at the end')
  }

  // A real paste, through the clipboard, after typed text.
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.evaluate((text) => navigator.clipboard.writeText(text), PASTED)
  await write(page, 'Typed first. ')
  await body(page).press('End')
  await body(page).press('ControlOrMeta+v')
  equal(await draftText(page), `Typed first. ${PASTED}`, 'a paste keeps its line breaks and blank lines')
  await body(page).press('ControlOrMeta+z')
  equal(await draftText(page), 'Typed first. ', 'Ctrl+Z after a paste brings back the text before it')
  await body(page).press('ControlOrMeta+v')
  await roundTrip(`Typed first. ${PASTED}`, 'pasted text')
  await dock(page).getByRole('button', { name: 'Discard' }).click()
}
