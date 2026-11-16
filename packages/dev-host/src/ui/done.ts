// The UI check for the reader's layout and the done states, over a `people-first` dev host
// of its own: the reader fills a 1920 px pane, Done and archive slide the row out with an
// undo toast, z brings the row back, an empty Your turn says so, and reduced motion is instant.

import type { Browser, Page } from 'playwright'
import { appErrors, capture, equal, openPage, SIZES } from './record.ts'

const yourTurn = (page: Page) => page.locator('[role="listbox"][aria-label="Your turn"] [role="option"]')
const rowIds = (page: Page) => yourTurn(page).evaluateAll((rows) => rows.map((row) => row.getAttribute('data-row')))
const count = (page: Page) => page.locator('section[aria-label="Your turn"] [data-field="count"]').textContent()
const selectedId = (page: Page) => page.locator('[role="option"][aria-selected="true"]').getAttribute('data-row')
const toast = (page: Page) => page.getByRole('status').filter({ has: page.locator('[data-field="toast"]') })
const nav = (page: Page, name: string) =>
  page.getByRole('navigation', { name: 'Sidebar' }).getByRole('button', { name: new RegExp(`^${name}`) })

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

/** At 1920 px the reader fills its pane: toolbar and messages 40 px in from each side, plain text capped near 72ch. */
async function checkReaderLayout(page: Page) {
  await page.setViewportSize(SIZES.full)
  await yourTurn(page).first().click()
  await page.locator('[data-message="open"] [data-field="body"] p').first().waitFor()
  const box = async (selector: string) => {
    const found = await page.locator(selector).first().boundingBox()
    if (!found) throw new Error(`the reader shows no ${selector}`)
    return { left: found.x, right: found.x + found.width, width: found.width }
  }
  const pane = await box('section[aria-label="Reader"]')
  const paragraph = await box('[data-message="open"] [data-field="body"] p')
  // 72ch in the paragraph's own font.
  const measure = await page
    .locator('[data-message="open"] [data-field="body"] p')
    .first()
    .evaluate((element) => {
      const ruler = document.createElement('span')
      ruler.style.cssText = 'position:absolute;width:72ch;height:0'
      element.append(ruler)
      const width = ruler.getBoundingClientRect().width
      ruler.remove()
      return width
    })
  const scrollbar = await page
    .locator('article[aria-label="Conversation"] > div')
    .evaluate((element) => element.getBoundingClientRect().width - element.clientWidth)
  const layout = {
    leftGap: (await box('section[aria-label="Reader"] button[title^="Done"]')).left - pane.left,
    searchGap: pane.right - (await box('section[aria-label="Reader"] form[role="search"]')).right,
    timeGap: pane.right - (await box('[data-message="open"] [data-field="message-time"]')).right,
    scrollbar,
    paragraph: paragraph.width,
    paragraphLeft: paragraph.left,
    bodyLeft: (await box('[data-message="open"] [data-field="body"]')).left,
    measure,
  }
  equal(layout.leftGap <= 40, true, `1920 px: Done sits at the pane's left edge (${layout.leftGap} px in)`)
  equal(layout.searchGap <= 40, true, `1920 px: search sits at the pane's right edge (${layout.searchGap} px in)`)
  equal(
    layout.timeGap <= 40 + layout.scrollbar,
    true,
    `1920 px: the message time lines up with the same right margin (${layout.timeGap} px in)`,
  )
  equal(
    Math.abs(layout.paragraph - layout.measure) < 1,
    true,
    `1920 px: a plain-text paragraph is capped at 72ch (${Math.round(layout.paragraph)} px of ${Math.round(layout.measure)} px)`,
  )
  equal(layout.paragraphLeft, layout.bodyLeft, '1920 px: the capped paragraph stays left-aligned')
  await capture(page, 'reader')
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
  await capture(page, 'done-toast')

  await page.keyboard.press('z')
  await page.locator(`[data-row="${first}"][aria-selected="true"]`).waitFor()
  equal(await rowIds(page), before, 'z brings the row back where it was')
  equal(await count(page), `${before.length}`, 'z restores the Your turn count')
  equal(await toast(page).count(), 0, 'z takes the toast down')
}

/** Archive in Inbox: the toast says "Archived", and its Undo button brings the row back. */
async function checkArchive(page: Page) {
  await nav(page, 'Inbox').click()
  const rows = page.locator('[data-list="mail"] [role="option"]')
  await rows.first().locator('[data-field="subject"]').waitFor()
  const id = await rows.first().getAttribute('data-row')
  const subtitle = await page.locator('[data-field="subtitle"]').textContent()
  await rows.first().click()
  await page.keyboard.press('e')
  await toast(page).waitFor()
  equal(await toast(page).locator('[data-field="toast"]').textContent(), 'Archived', 'archive shows "Archived"')
  await page.locator(`[data-row="${id}"]`).waitFor({ state: 'detached' })
  await toast(page).getByRole('button', { name: /^Undo/ }).click()
  await page.locator(`[data-row="${id}"][aria-selected="true"]`).waitFor()
  equal(
    await page.locator('[data-field="subtitle"]').textContent(),
    subtitle,
    'Undo puts the archived row back in Inbox',
  )
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
  const { page, errors, close } = await openPage(browser, url, 'trace-done.zip')
  await yourTurn(page).first().locator('[data-field="subject"]').waitFor()
  await checkReaderLayout(page)
  await page.setViewportSize(SIZES.wide)
  await checkDoneAndUndo(page)
  await checkArchive(page)

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

  equal(appErrors(errors), [], 'the done states logged no errors')
  await close()
}
