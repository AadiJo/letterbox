// The UI check for the reader's layout and the done states, over a `people-first` dev host
// of its own: the reading column stays by the list at 1920 px, Done slides the row out with an
// undo toast and z brings it back, archive and Trash offer the same undo through the core,
// trash from Sent keeps its row on a labels account, an undo says "Undoing…" until the core
// answers and why when it is refused, a late answer or a scroll moves no row it should not,
// an empty Your turn says so, and reduced motion is instant.

import type { Browser, Page } from 'playwright'
import {
  appErrors,
  boxOf,
  capture,
  captureC2,
  equal,
  openPage,
  overlaps,
  type Relay,
  ROW_HEIGHT,
  SIZES,
  WAIT_MS,
} from './record.ts'
import { conversations, mailRows, nav, openInbox, settle, toast, waitForTotal } from './mail-list.ts'
import { checkUndo } from './undo.ts'

const yourTurn = (page: Page) => page.locator('[role="listbox"][aria-label="Your turn"] [role="option"]')
const rowIds = (page: Page) => yourTurn(page).evaluateAll((rows) => rows.map((row) => row.getAttribute('data-row')))
const count = (page: Page) => page.locator('section[aria-label="Your turn"] [data-field="count"]').textContent()
const selectedId = (page: Page) => page.locator('[role="option"][aria-selected="true"]').getAttribute('data-row')

/**
 * Resolves, once the Your turn count next changes, with whether row `id` is still in the
 * page at that moment. With motion the row is still sliding out; without, it went in the
 * same update that lowered the count. No timer decides either.
 */
const rowWhenCountDrops = (page: Page, id: string) =>
  page.evaluate(
    (row) =>
      new Promise<boolean>((resolve) => {
        const section = document.querySelector('section[aria-label="Your turn"]')
        const read = () => section?.querySelector('[data-field="count"]')?.textContent
        if (!section) throw new Error('People has no Your turn section')
        const before = read()
        const observer = new MutationObserver(() => {
          if (read() === before) return
          observer.disconnect()
          resolve(document.querySelector(`[data-row="${row}"]`) !== null)
        })
        observer.observe(section, { childList: true, subtree: true, characterData: true })
      }),
    id,
  )

/**
 * At 1920 px the reading column keeps its width but stays within 64 px of the list, and the
 * toolbar, subject, messages and reply bar all start on its edge. Plain text is capped at 62ch.
 */
async function checkReaderLayout(page: Page) {
  await page.setViewportSize(SIZES.full)
  await yourTurn(page).first().click()
  const paragraph = '[data-message="open"] [data-field="body"] p'
  await page.locator(paragraph).first().waitFor()
  const list = await boxOf(page, 'section[aria-label="People"]')
  const subject = await boxOf(page, '[data-field="reader-subject"]')
  const edges = {
    toolbar: (await boxOf(page, 'section[aria-label="Reader"] button[aria-keyshortcuts="d"]')).left,
    folded: (await boxOf(page, '[data-message="folded"]')).left,
    open: (await boxOf(page, '[data-message="open"]')).left,
    body: (await boxOf(page, paragraph)).left,
    reply: (await boxOf(page, '[data-field="reply-bar"]')).left,
  }
  equal(Math.round(list.right - list.left), 392, '1920 px: the list is 392 px wide')
  equal(
    await page.locator('[data-field="attachment"]').count(),
    0,
    'a message with no attachments shows no attachment row',
  )
  equal(
    subject.left - list.right <= 64,
    true,
    `1920 px: the reading column starts ${subject.left - list.right} px from the list, at most 64`,
  )
  equal(
    Object.entries(edges).filter(([, left]) => Math.abs(left - subject.left) > 0.5),
    [],
    "1920 px: the toolbar, messages, body and reply bar start on the subject's edge",
  )
  const search = await boxOf(page, 'section[aria-label="Reader"] form[role="search"]')
  equal(Math.round(search.right - subject.left), 720, "1920 px: search ends on the 720 px column's right edge")
  // 62ch in the paragraph's own font.
  const capped = await page
    .locator(paragraph)
    .first()
    .evaluate((element) => {
      const ruler = document.createElement('span')
      ruler.style.cssText = 'position:absolute;width:62ch;height:0'
      element.append(ruler)
      const measure = ruler.getBoundingClientRect().width
      ruler.remove()
      return Math.abs(element.getBoundingClientRect().width - measure) < 1
    })
  equal(capped, true, '1920 px: a plain-text paragraph is capped at 62ch')
  await capture(page, 'reader')
}

/** Checks the toast floats over the reader and covers no list row, at `size`. */
async function checkToastClear(page: Page, size: keyof typeof SIZES) {
  await page.setViewportSize(SIZES[size])
  const box = await boxOf(page, '[role="status"]:has([data-field="toast"])')
  const reader = await boxOf(page, 'section[aria-label="Reader"]')
  const rows = await page.locator('[role="option"]').evaluateAll((found) =>
    found.map((row) => {
      const { left, top, right, bottom } = row.getBoundingClientRect()
      return { left, top, right, bottom }
    }),
  )
  equal(
    [rows.filter((row) => overlaps(box, row)).length, box.left >= reader.left && box.right <= reader.right],
    [0, true],
    `${size}: the toast sits over the reader and covers no list row`,
  )
  await page.setViewportSize(SIZES.wide)
}

/** Done: the row slides out with a toast, the next one opens, and z puts it back, open. */
async function checkDoneAndUndo(page: Page) {
  const before = await rowIds(page)
  const [first, second] = before
  if (!first || !second) throw new Error('Your turn shows fewer than two conversations')
  await page.locator(`[data-row="${first}"]`).click()
  const stillThere = rowWhenCountDrops(page, first)
  await page.keyboard.press('d')
  equal(await stillThere, true, 'Done: the row is still sliding out when the count drops')
  await toast(page).waitFor()
  equal(await toast(page).locator('[data-field="toast"]').textContent(), 'Marked done', 'Done shows "Marked done"')
  await page.locator(`[data-row="${first}"]`).waitFor({ state: 'detached' })
  equal(await count(page), `${before.length - 1}`, 'Done lowers the Your turn count')
  equal(await selectedId(page), second, 'the next conversation opens as the row folds')

  // z before any screenshot, so the toast's 5 s cannot run out first on a slow machine.
  await page.keyboard.press('z')
  await page.locator(`[data-row="${first}"][aria-selected="true"]`).waitFor()
  equal(await rowIds(page), before, 'z brings the row back where it was')
  equal(await count(page), `${before.length}`, 'z restores the Your turn count')
  equal(await toast(page).count(), 0, 'z takes the toast down')

  // Done again, for the pictures, once the row has folded away.
  await page.keyboard.press('d')
  await toast(page).waitFor()
  await page.locator(`[data-row="${first}"]`).waitFor({ state: 'detached' })
  // Tomas's lease addendum carries its PDF, shown as a row under the body.
  equal(
    await page
      .locator('[data-message="open"] [data-field="attachment"]')
      .evaluateAll((files) =>
        files.map((file) =>
          ['type', 'name', 'size'].map((part) => file.querySelector(`[data-field="${part}"]`)?.textContent),
        ),
      ),
    [['PDF', 'Addendum-4B-signed-TO.pdf', '212 KB']],
    "a message's attachment shows as a row with its type, name and size",
  )
  await checkToastClear(page, 'wide')
  await checkToastClear(page, 'narrow')
  await captureC2(page, 'done-1440')
  await capture(page, 'done-toast')
}

/** An archive the core accepts after the user left Inbox moves nothing and says nothing where they went. */
/** Opens Inbox on a conversation both lists show at once: in Inbox, and among All mail's first rows. */
async function openSharedRow(page: Page) {
  await nav(page, 'All mail').click()
  await mailRows(page).first().locator('[data-field="subject"]').waitFor()
  const inAllMail = await mailRows(page).evaluateAll((rows) => rows.map((row) => row.getAttribute('data-row')))
  await openInbox(page)
  const inInbox = await mailRows(page).evaluateAll((rows) => rows.map((row) => row.getAttribute('data-row')))
  const id = inInbox.find((candidate) => inAllMail.includes(candidate))
  if (!id) throw new Error('no conversation shows in Inbox and at the top of All mail')
  await page.locator(`[data-list="mail"] [data-row="${id}"]`).click()
  return id
}

async function checkLateArchive(page: Page, relay: Relay) {
  const id = await openSharedRow(page)
  const total = await conversations(page)
  const paused = relay.pauseAtAccepted()
  await page.keyboard.press('e')
  await paused
  await nav(page, 'All mail').click()
  const there = page.locator(`[data-list="mail"] [data-row="${id}"]`)
  await there.locator('[data-field="subject"]').waitFor()
  relay.resume()
  await settle(page)
  equal(
    await there.evaluate((row) => row.getAnimations().length),
    0,
    'an archive accepted after leaving Inbox moves no row in All mail',
  )
  equal(await toast(page).count(), 0, 'an archive accepted after leaving Inbox shows no toast')
  await openInbox(page)
  await waitForTotal(page, total - 1)
}

/**
 * Leaving Inbox while an archived row slides out moves nothing in All mail. All mail mounts
 * its row for the same conversation before Inbox's row goes, and that row is not the one
 * that was leaving. The page counts every animation started on a connected row for the
 * conversation from the moment it opens All mail.
 */
async function checkLeaveDuringExit(page: Page) {
  const id = await openSharedRow(page)
  const left = page.evaluate(
    ([leaving, waitMs]) =>
      new Promise<void>((resolve, reject) => {
        const subtitle = document.querySelector('[data-field="subtitle"]')
        const row = document.querySelector(`[data-list="mail"] [data-row="${leaving}"]`)
        const allMail = [...document.querySelectorAll<HTMLElement>('nav[aria-label="Sidebar"] button')].find((button) =>
          button.textContent?.startsWith('All mail'),
        )
        if (!subtitle || !row || !allMail) throw new Error('Inbox, its row or the All mail button is missing')
        const before = subtitle.textContent
        const fail = (message: string) => {
          observer.disconnect()
          clearTimeout(timer)
          reject(new Error(message))
        }
        // Once the core has taken the row out of Inbox, while the row still slides out.
        const observer = new MutationObserver(() => {
          if (!row.isConnected && subtitle.textContent === before)
            return fail('the row finished leaving before the core took it out of Inbox, so the check missed the exit')
          if (subtitle.textContent === before || !row.isConnected) return
          observer.disconnect()
          clearTimeout(timer)
          document.body.dataset.rowAnimations = '0'
          const animate = Element.prototype.animate
          Element.prototype.animate = function (...args) {
            if (this.isConnected && this.getAttribute('data-row') === leaving)
              document.body.dataset.rowAnimations = String(Number(document.body.dataset.rowAnimations) + 1)
            return animate.apply(this, args)
          }
          allMail.click()
          resolve()
        })
        const timer = setTimeout(() => fail(`the core did not take the row out of Inbox within ${waitMs} ms`), waitMs)
        observer.observe(document.body, { childList: true, subtree: true, characterData: true })
      }),
    [id, WAIT_MS] as const,
  )
  await page.keyboard.press('e')
  await left
  await page.locator(`[data-list="mail"] [data-row="${id}"] [data-field="subject"]`).waitFor()
  await settle(page)
  equal(
    await page.evaluate(() => document.body.dataset.rowAnimations),
    '0',
    "leaving Inbox mid-exit runs no animation on All mail's row for the same conversation",
  )
}

/**
 * A scroll while a row leaves a windowed list ends its exit at once. The row is never
 * placed in the window the scroll moved to, which would set it among rows it never sat
 * beside and add a row past the window's size.
 */
async function checkScrollDuringExit(page: Page) {
  await openInbox(page)
  const id = await mailRows(page).nth(1).getAttribute('data-row')
  if (!id) throw new Error('Inbox shows fewer than two conversations')
  await mailRows(page).nth(1).click()
  // Once the row starts to slide, scroll ten rows down, then report whether the row is
  // still there when the list first renders the moved window (its top spacer changes).
  const placed = page.locator('[data-list="mail"]').evaluate(
    (list, [leaving, rowHeight]) =>
      new Promise<boolean>((resolve) => {
        const row = list.querySelector(`[data-row="${leaving}"]`)
        const spacer = list.firstElementChild
        if (!row || !(spacer instanceof HTMLElement)) throw new Error('Inbox has no such row')
        const scroll = () => {
          if (row.getAnimations().length === 0) return void requestAnimationFrame(scroll)
          const top = spacer.style.height
          const observer = new MutationObserver(() => {
            if (spacer.style.height === top) return
            observer.disconnect()
            resolve(list.querySelector(`[data-row="${leaving}"]`) !== null)
          })
          observer.observe(list, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] })
          list.scrollTop += 10 * rowHeight
        }
        scroll()
      }),
    [id, ROW_HEIGHT] as const,
  )
  await page.keyboard.press('e')
  equal(await placed, false, 'scrolling during an exit drops the leaving row from the moved window')
  await page.locator('[data-list="mail"]').evaluate((list) => list.scrollTo({ top: 0 }))
}

/** Marks every Your turn conversation done, one after another, each once the one before has gone. */
async function clearYourTurn(page: Page): Promise<void> {
  const [id] = await rowIds(page)
  if (!id) return
  await page.keyboard.press('d')
  await page.locator(`[data-row="${id}"]`).waitFor({ state: 'detached' })
  return clearYourTurn(page)
}

export async function checkDone(browser: Browser, url: string) {
  const { page, relay, errors, close } = await openPage(browser, url, 'trace-done.zip')
  await yourTurn(page).first().locator('[data-field="subject"]').waitFor()
  await checkReaderLayout(page)
  await page.setViewportSize(SIZES.wide)
  await checkDoneAndUndo(page)
  await checkLateArchive(page, relay)
  await checkLeaveDuringExit(page)
  await checkUndo(page, relay)
  await checkScrollDuringExit(page)

  // Clearing Your turn leaves the empty state.
  await nav(page, 'People').click()
  await yourTurn(page).first().click()
  await clearYourTurn(page)
  const empty = page.locator('section[aria-label="Your turn"] [data-field="empty"]')
  equal(await empty.textContent(), 'Nothing waits on you', 'an empty Your turn says "Nothing waits on you"')
  equal(await count(page), '0', 'the Your turn count reads 0')

  // With reduced motion, the row goes in the same update that lowers the count.
  await page.keyboard.press('z')
  await yourTurn(page).first().waitFor()
  const [back] = await rowIds(page)
  if (!back) throw new Error('z brought nothing back to Your turn')
  await page.locator(`[data-row="${back}"][aria-selected="true"]`).waitFor()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const stillThere = rowWhenCountDrops(page, back)
  await page.keyboard.press('d')
  equal(await stillThere, false, 'reduced motion: the row is gone in the same frame the count drops')
  await empty.waitFor()
  await capture(page, 'nothing-waits')

  // The undo checks end the connection on purpose (undo.ts).
  equal(appErrors(errors, { lostCore: true }), [], 'the done states logged no errors')
  await close()
}
