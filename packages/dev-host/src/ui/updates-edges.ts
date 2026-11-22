// The Updates UI check's page helpers, and its checks at the edges: the keyboard past the
// list's loaded window, and Let go? and Updates once the core is lost. updates.ts runs them.

import type { Locator, Page } from 'playwright'
import { equal, SIZES } from './record.ts'

export const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' })
export const nav = (page: Page, name: string) => sidebar(page).getByRole('button', { name: new RegExp(`^${name}`) })
export const text = (page: Page, selector: string) => page.locator(selector).first().textContent()
export const toast = (page: Page) =>
  page.locator('[role="status"]').filter({ has: page.locator('[data-field="toast"]') })
export const senderRow = (page: Page, name: string) =>
  page
    .locator('[data-sender]')
    .filter({ has: page.locator('[data-field="person"]', { hasText: new RegExp(`^${name}$`) }) })

/** Waits for the page's `selector` to read `expected`. */
export const waitForText = (page: Page, selector: string, expected: string) =>
  page.waitForFunction(([where, wanted]) => document.querySelector(where)?.textContent === wanted, [
    selector,
    expected,
  ] as const)

/** The text of every match of `selector` under `within`. */
export const texts = (within: Locator, selector: string) =>
  within.locator(selector).evaluateAll((all) => all.map((one) => one.textContent ?? ''))

/**
 * With the open sender scrolled out of the list, j opens the next sender the list has loaded,
 * and the list scrolls to it, even when its row was not painted. In a 1024 by 700 window, the
 * last screen of the list leaves loaded rows above the painted ones.
 */
export async function checkKeyboardPastTheWindow(page: Page, lastSender: string) {
  const list = page.locator('[role="listbox"][aria-label="Updates"]')
  await page.setViewportSize(SIZES.narrow)
  await list.evaluate((element) => element.scrollTo({ top: element.scrollHeight }))
  await senderRow(page, lastSender).waitFor()
  equal(
    await page.locator('[data-sender][aria-selected="true"]').count(),
    0,
    'the open sender has scrolled out of the list',
  )
  await page.keyboard.press('j')
  const opened = page.locator('[data-sender][aria-selected="true"]')
  await opened.waitFor()
  const [row, box] = [await opened.boundingBox(), await list.boundingBox()]
  equal(
    row !== null && box !== null && row.y >= box.y && row.y + row.height <= box.y + box.height,
    true,
    'j opens a sender the list then scrolls fully into view',
  )
  await page.setViewportSize(SIZES.wide)
  await list.evaluate((element) => element.scrollTo({ top: 0 }))
  await senderRow(page, 'Codeyard').click()
  await page.locator('[data-field="archive-count"]').waitFor()
}

/** How a control looks off while the core is lost: disabled, and dimmed whole to 40%. */
const offWhileLost = (control: Locator) =>
  control.evaluate((element) => ({
    disabled: element instanceof HTMLButtonElement && element.disabled,
    opacity: getComputedStyle(element).opacity,
  }))

/**
 * With the core lost, Let go in Done's slot is off at 40%, as Done and the toolbar's actions
 * are, and d lets nothing go. Then Updates, opened after the loss, shows the strip, and Mark
 * read and Archive all are off for a sender with unread mail.
 */
export async function checkLost(page: Page, drop: () => Promise<void>) {
  await nav(page, 'Let go').click()
  await page.locator('[role="option"]').first().click()
  await page.locator('[data-field="waited"]').waitFor()
  const count = await text(page, '[data-field="let-go-count"]')
  await drop()
  await page.locator('[data-field="lost-core"]').waitFor()
  const letGo = page.getByRole('button', { name: 'Let go', exact: true })
  equal(await offWhileLost(letGo), { disabled: true, opacity: '0.4' }, 'while lost, Let go is off at 40%, like Done')
  await page.keyboard.press('d')
  equal(await text(page, '[data-field="let-go-count"]'), count, 'while lost, d lets nothing go')

  // Switching to Updates while lost: the list keeps the senders it last had, and opening one
  // with unread mail shows its two buttons off, as the toolbar's are, under the strip.
  await nav(page, 'Updates').click()
  const reader = page.locator('section[aria-label="Reader"]')
  await reader.locator('[data-field="lost-core"]').waitFor()
  equal(await reader.locator('[data-field="lost-core"]').count(), 1, 'while lost, Updates shows the lost-core strip')
  await senderRow(page, 'Codeyard').click()
  const markRead = reader.getByRole('button', { name: /^Mark \d+ read$/ })
  const archiveAll = reader.getByRole('button', { name: /^Archive all/ })
  equal(
    [await offWhileLost(markRead), await offWhileLost(archiveAll)],
    [
      { disabled: true, opacity: '0.4' },
      { disabled: true, opacity: '0.4' },
    ],
    'while lost, Mark read and Archive all are off at 40%, though Codeyard has unread mail',
  )
}
