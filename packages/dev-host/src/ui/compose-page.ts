// What the compose UI check (compose.ts, forward.ts) shares: the mail it adds to the
// people-first seed so the screens match the mocks in mocks/features/compose, and the ways
// it finds and reads the compose page.

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from 'playwright'
import { ARTIFACTS, SIZES } from './record.ts'
import { minutesAgo, ROBIN, seed } from './reply-page.ts'

const PRIYA = { name: 'Priya Raman', address: 'priya@ramanpress.test' }
const HANA = { name: 'Hana Sato', address: 'hana@satotranslate.test' }

/** The files Priya's newest message carries, as the mock shows them. */
export const COVER_FILES = [
  { name: 'Issue-12-cover-v3.pdf', mime: 'application/pdf', size: 4_404_019 },
  { name: 'masthead-options.png', mime: 'image/png', size: 880_640 },
]

/** The text Priya's newest message ends the conversation with, as in the mock. */
export const COVER_TEXT = [
  'Hi Robin,',
  'Went with the darker green in the end. It holds up better on the newsstand proofs, and the logo finally reads at thumbnail size.',
  'The masthead still feels a little tight at the top, though. I’ve attached the full cover and the three masthead options we talked about. Could you get a second opinion on the margins before the printer locks the file on Friday?',
  'Priya',
].join('\n\n')

/** The keys of the seed's "Cover draft for issue 12", oldest first, which COVER answers. */
const coverKeys = seed.seed.messages
  .filter((message) => message.subject.endsWith('Cover draft for issue 12'))
  .map((message) => message.key)

/** Priya's newest message, with two files, to the user and copying Hana, so Reply all and Forward both show. */
export const COVER = {
  key: 'cover-files',
  mailboxes: ['inbox', 'projects'],
  from: PRIYA,
  to: [ROBIN],
  cc: [HANA],
  subject: 'Re: Cover draft for issue 12',
  text: COVER_TEXT,
  sentAt: minutesAgo(7 * 60 + 20),
  replyTo: coverKeys,
  attachments: COVER_FILES,
}

/** People who wrote long ago, past People's 30 days, so the core suggests them and no list shows them. */
const OLD = [
  { name: 'Jules Moreau', address: 'jules@moreaustudio.test', subject: 'Interview plan' },
  { name: 'Nadia Petrov', address: 'nadia@petrovprint.test', subject: 'Print slots for spring' },
  { name: 'Malik Haddad', address: 'malik.haddad@harbourmail.test', subject: 'Harbour walk photos' },
].map((person, index) => ({
  key: `old-${index}`,
  mailboxes: ['inbox'],
  from: { name: person.name, address: person.address },
  to: [ROBIN],
  subject: person.subject,
  text: `Hi Robin, a note about ${person.subject.toLowerCase()}.`,
  sentAt: minutesAgo((40 + index) * 24 * 60),
}))

/** Everything the check adds to the seed before the page signs in. */
export const ADDED = [COVER, ...OLD]

export const pageOf = (page: Page, title: 'New message' | 'Forward') => page.locator(`section[aria-label="${title}"]`)
/** The compose page, whichever it holds. */
export const composePage = (page: Page) =>
  page.locator('section[aria-label="New message"], section[aria-label="Forward"]')
export const suggestions = (page: Page) => page.getByRole('listbox', { name: 'Suggestions' })
export const lineInput = (page: Page, line: 'to' | 'cc' | 'bcc') =>
  composePage(page).locator(`input[data-line="${line}"]`)
export const subjectField = (page: Page) => composePage(page).getByRole('textbox', { name: 'Subject' })
export const text = (page: Page) => composePage(page).getByRole('textbox', { name: 'Message', exact: true })
export const selectedRows = (page: Page) => page.locator('[role="option"][aria-selected="true"][data-row]')

/** The people on one address line of the page, as each chip's tooltip names them. */
export const pageChips = (page: Page, line: 'to' | 'cc' | 'bcc') =>
  composePage(page)
    .locator(`[data-address-line="${line}"] [data-chip]`)
    .evaluateAll((found) => found.map((chip) => chip.getAttribute('title')))

/** Each suggestion's name line, and the parts of it marked as matching what was typed. */
export const suggested = (page: Page) =>
  suggestions(page)
    .getByRole('option')
    .evaluateAll((options) =>
      options.map((option) => ({
        name: option.querySelector('[data-field="name"]')?.textContent ?? '',
        marked: [...option.querySelectorAll('b')].map((mark) => mark.textContent),
        age: option.querySelector('[data-field="last-mail"]')?.textContent ?? null,
        active: option.getAttribute('aria-selected') === 'true',
      })),
    )

/** The address lines the page shows, top to bottom. */
export const lines = (page: Page) =>
  composePage(page)
    .locator('[data-address-line]')
    .evaluateAll((found) => found.map((line) => line.getAttribute('data-address-line')))

/** The names of the original's files the forward shows. */
export const forwardFiles = (page: Page) =>
  composePage(page)
    .locator('[data-field="forward-file"]')
    .evaluateAll((files) => files.map((file) => file.querySelector('.truncate')?.textContent))

/** Screenshots the page at `size` and twice its pixels as `<scene>-<width>.png`. `before` runs once it is at that size. */
async function shoot(page: Page, scene: string, size: { width: number; height: number }, before?: () => Promise<void>) {
  const cdp = await page.context().newCDPSession(page)
  await page.setViewportSize(size)
  await cdp.send('Emulation.setDeviceMetricsOverride', { ...size, deviceScaleFactor: 2, mobile: false })
  await before?.()
  await page.evaluate(() => Promise.allSettled(document.getAnimations().map((animation) => animation.finished)))
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(ARTIFACTS, `${scene}-${size.width}.png`), Buffer.from(data, 'base64'))
  await cdp.send('Emulation.clearDeviceMetricsOverride')
  await cdp.detach()
}

/**
 * Screenshots the page as `<scene>-1440.png` and `<scene>-1024.png`, each at twice its pixels
 * as the mocks are, to compare with the mock's scene of the same name. `before` runs once the
 * page is at each size, for a hover that must land on the final layout.
 */
export async function captureScene(page: Page, scene: string, before?: () => Promise<void>) {
  await shoot(page, scene, SIZES.wide, before)
  await shoot(page, scene, SIZES.narrow, before)
  await page.setViewportSize(SIZES.wide)
}
