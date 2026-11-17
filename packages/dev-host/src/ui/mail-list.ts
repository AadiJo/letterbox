// What the mail list UI checks share: the toast, the sidebar, and a mail list's rows and count.

import type { Page } from 'playwright'

export const toast = (page: Page) => page.getByRole('status').filter({ has: page.locator('[data-field="toast"]') })
export const nav = (page: Page, name: string) =>
  page.getByRole('navigation', { name: 'Sidebar' }).getByRole('button', { name: new RegExp(`^${name}`) })

/** Resolves once the core has answered everything the page sent, and the page any reaction to that. */
export const settle = async (page: Page) => {
  await page.evaluate(() => window.letterboxDev?.settle())
  await page.evaluate(() => window.letterboxDev?.settle())
}

export const mailRows = (page: Page) => page.locator('[data-list="mail"] [role="option"]')
export const conversations = async (page: Page) =>
  Number.parseInt((await page.locator('[data-field="subtitle"]').textContent()) ?? '', 10)

/** Waits for a mail list's header to count `total` conversations. */
export const waitForTotal = (page: Page, total: number) =>
  page.waitForFunction(
    (expected) => document.querySelector('[data-field="subtitle"]')?.textContent === `${expected} conversations`,
    total,
  )

/** Opens Inbox and waits for its rows. */
export async function openInbox(page: Page) {
  await nav(page, 'Inbox').click()
  await mailRows(page).first().locator('[data-field="subject"]').waitFor()
}
