// The body UI check's second half (body.ts runs it): mail that tries what hostile mail tries on
// the reader's frame, and quoted history.
//   - Harbour Lane's statements: the folded frame holds the new part only, with none of the
//     link, base, iframe and scripts the mail names, and it is as tall as the document, body
//     margins included. Forms named after the document's methods do not stop images loading.
//     The sender's CSS names what the shown CSS image would be called without the core's random
//     prefix, so the image lands only on its own element. With two messages open, I in the
//     older one's menu shows that one's images, and I outside a menu the newest's. The quote
//     opens under its line in a frame of its own, and the line stays at the quote's start.
//   - Ines's HTML reply: no trackers, so its menu says nothing about them, and its quote folds.
//   - Dara's plain-text reply: the quote folds behind one line and opens to each level on its
//     rule. Folded rows preview the new text only.
//   - A list reply quoted 10,000 levels deep opens to 8 levels.
//   - Updates: a new message in the open conversation shows folded, though the one before it
//     had its quote open.

import type { SeedMessage, SimMailbox } from '@letterbox/sim-provider/contract'
import type { Page } from 'playwright'
import {
  capture,
  chipOf,
  focused,
  frameOf,
  menu,
  menuSays,
  NEWEST,
  opened,
  readFrame,
  waitImages,
} from './body-frame.ts'
import { equal } from './record.ts'
import { ME, open, seed } from './reply-page.ts'
import { nav, senderRow } from './updates-edges.ts'

const STATEMENT = 'Your Harbour Lane statement'
const HARBOUR = { name: 'Harbour Lane Accounts', address: 'statements@harbourlane.example' }
const INES = 'Invoice 2291, line 4'
const DARA = 'Quote for the kitchen shelves'
const DEEP = 'The long thread'
const LINE = '[data-field="quote-line"]'
const QUOTED = { nth: -1, title: 'Quoted history' } as const

/** Waits until the newest open message's quote frame has loaded the quote. */
const quoteLoaded = (page: Page) =>
  page.waitForFunction(() => {
    const doc = [...document.querySelectorAll('[data-message="open"]')]
      .at(-1)
      ?.querySelector<HTMLIFrameElement>('iframe[title="Quoted history"]')?.contentDocument
    return doc ? Document.prototype.querySelectorAll.call(doc, '.gmail_quote').length > 0 : false
  })

/** How the frame, the line and the quote's frame of the newest open message sit, top to bottom. */
const stacked = (page: Page) =>
  opened(page, -1).evaluate((message, line) => {
    const box = (selector: string) => message.querySelector(selector)?.getBoundingClientRect()
    const [frame, toggle, quote] = [box('iframe[title="Message"]'), box(line), box('iframe[title="Quoted history"]')]
    return frame && toggle && quote ? frame.bottom <= toggle.top && toggle.bottom <= quote.top : null
  }, LINE)

/** Harbour Lane's statements: hostile markup, prefixed CSS images, two open messages, and the quote's own frame. */
export async function checkStatement(page: Page) {
  await nav(page, 'Inbox').click()
  await open(page, STATEMENT)
  const folded = await readFrame(page, NEWEST)
  equal(
    [
      folded?.text,
      folded?.hostile,
      folded?.quote,
      folded?.title,
      folded?.fits.scrolls,
      folded?.fits.frame === folded?.fits.document,
    ],
    ['Harbour Lane Your February statement is ready. The balance is €42.10, due on March 20.', 0, 0, '', false, true],
    'folded, the frame holds the new part only, none of the link, base, iframe and scripts reach it, nothing ran, and it is as tall as its document, body margins and all',
  )

  // Two open messages, both with images off: I in the older one's menu shows the older one's.
  await page.locator('[data-message="folded"]').first().click()
  await chipOf(page, 0).click()
  await page.keyboard.press('i')
  await page.locator('[data-message="open"]').first().locator('[data-images="message"]').waitFor()
  equal(
    [await chipOf(page, 1).getAttribute('data-images'), await focused(chipOf(page, 0))],
    ['blocked', true],
    'I in the older message’s menu shows that message’s images, not the newest’s, and focus goes back to its chip',
  )
  // Outside a menu, I shows the newest open message's.
  await page.keyboard.press('i')
  await waitImages(page, NEWEST, 1)
  const shown = await readFrame(page, NEWEST)
  equal(
    [shown?.images, shown?.formBackground, shown?.css, shown?.fits.scrolls],
    [
      [{ alt: 'Harbour Lane', type: 'data:image/png', loaded: true }],
      ['data:image/png'],
      { drawn: ['url("data:image/png;base64'], decoys: ['none', 'none'] },
      false,
    ],
    'I outside a menu shows the newest message’s: forms named after the document’s methods stop nothing, and the CSS image lands only on its own element, never where the sender’s CSS names it',
  )

  // The quote opens in a frame of its own under its line, which stays at the quote's start.
  const line = opened(page, -1).locator(LINE)
  await line.click()
  await quoteLoaded(page)
  const quote = await readFrame(page, QUOTED)
  equal(
    [quote?.text, quote?.hostile, quote?.fits.scrolls, (await readFrame(page, NEWEST))?.quote, await stacked(page)],
    [
      'On Sat, Feb 28, 2026, Harbour Lane Accounts <statements@harbourlane.example> wrote: Your January statement is ready. The balance is €0.00.',
      0,
      false,
      0,
      true,
    ],
    'Show opens the quote in a frame under the line, the new part left out and nothing hostile in it, while the frame above keeps the new part',
  )
  await line.click()
  await frameOf(page, QUOTED).waitFor({ state: 'detached' })
}

/** Ines's HTML reply: no trackers, Show images from the menu, and its quoted history folded and open. */
export async function checkInes(page: Page) {
  await nav(page, 'People').click()
  await open(page, INES)
  await chipOf(page).click()
  equal(
    await menuSays(page),
    { items: ['Show imagesI'], note: null },
    'with no trackers, the menu says nothing about them',
  )
  await menu(page).getByRole('menuitem', { name: 'Show images' }).click()
  await waitImages(page, NEWEST, 1)
  const folded = await readFrame(page, NEWEST)
  equal(
    [folded?.text, folded?.quote],
    [
      'Hi Robin, Our accounts team flagged line 4. It looks like the October hours were billed twice, once on the weekly sheet and again on the monthly summary. I can issue a credit note for €380, or reissue the invoice without the line. Which would you prefer for your records? Ines',
      0,
    ],
    'folded, the frame holds the new part only',
  )
  const line = opened(page, -1).locator(LINE)
  equal(
    await line.evaluate((element) => [element.textContent, element.getAttribute('aria-expanded')]),
    ['Quoted history·all in this conversationShow', 'false'],
    'under the frame, the quoted history folds behind one line that says it is all in this conversation',
  )
  await line.click()
  await quoteLoaded(page)
  await waitImages(page, NEWEST, 1)
  equal(
    [
      await line.evaluate((element) => [element.textContent?.endsWith('Hide'), element.getAttribute('aria-expanded')]),
      (await readFrame(page, QUOTED))?.text.includes('Our accounts team'),
      await stacked(page),
    ],
    [[true, 'true'], false, true],
    'Show opens the quote below the line, which reads Hide, and the images above stay shown',
  )
}

/** Dara's plain-text reply: the quote folds, opens level by level, and folded rows preview new text only. */
export async function checkDara(page: Page) {
  await open(page, DARA)
  const message = opened(page, -1)
  const line = message.locator(LINE)
  equal(
    [
      await message.locator('[data-field="body"] > p').evaluateAll((all) => all.map((p) => p.textContent)),
      await line.evaluate((element) => {
        const box = element.getBoundingClientRect()
        return { height: box.height, top: getComputedStyle(element).borderTopWidth, text: element.textContent }
      }),
      await message.locator('[data-field="quoted"]').count(),
    ],
    [
      [
        'Hi Robin,',
        'Oak comes in at €1,140 fitted, birch ply at €860. Happy to bring samples by next week.',
        'Both prices include the brackets and making good the wall. The ply can be oiled or left raw. Raw marks more easily near the cooker.',
        'Dara',
      ],
      { height: 36, top: '1px', text: 'Quoted history·all in this conversationShow' },
      0,
    ],
    'folded, a plain reply shows its new text, then a 36 px line with a hairline on top, and no quoted text',
  )
  equal(
    await page
      .locator('[data-message="folded"]')
      .evaluateAll((rows) => rows.map((element) => element.querySelector('[data-field="preview"]')?.textContent)),
    [
      'Hi Dara, We’re after three open shelves for the kitchen wall, about 1.2 m each. Could you quote for oak, and for something cheaper? Robin',
      'Hi Robin, Happy to. I’ll measure up on Thursday if someone’s in. Do you know if there are pipes behind that wall? Dara',
    ],
    'folded rows preview each message’s new text',
  )
  await line.scrollIntoViewIfNeeded()
  await capture(page, 'body-quote-folded')

  await line.click()
  const levels = await message.locator('[data-field="quote-level"]').evaluateAll((all) =>
    all.map((level) => ({
      cite: level.querySelector(':scope > .text-cite')?.textContent,
      rule: getComputedStyle(level).borderLeftWidth,
      first: level.querySelector(':scope > .text-quote')?.textContent,
    })),
  )
  equal(
    [levels, await line.textContent()],
    [
      [
        {
          cite: 'On Fri, Feb 20, 2026 at 8:00 PM, Dara Quinn <dara@quinnjoinery.test> wrote:',
          rule: '2px',
          first: 'Hi Robin,',
        },
        {
          cite: 'On Fri, Feb 20, 2026 at 12:00 AM, Robin Vale <robin@vale.test> wrote:',
          rule: '2px',
          first: 'Hi Dara,',
        },
      ],
      'Quoted history·all in this conversationHide',
    ],
    'Show opens each quoted message a level in, on a 2 px rule under its attribution, and the line reads Hide',
  )
  await message.locator('[data-field="quoted"]').scrollIntoViewIfNeeded()
  await capture(page, 'body-quote-open')
}

/** A quote 10,000 levels deep opens to 8 levels, its text at the deepest. */
export async function checkDeep(page: Page) {
  await nav(page, 'Inbox').click()
  await open(page, DEEP)
  await opened(page, -1).locator(LINE).click()
  const levels = opened(page, -1).locator('[data-field="quote-level"]')
  equal(
    [await levels.count(), await levels.last().locator(':scope > .text-quote').textContent()],
    [8, 'The first message in the thread.'],
    'a quote 10,000 levels deep opens to 8 levels, its text at the deepest',
  )
}

/** One more message in Harbour Lane's conversation, from the sim provider, as new mail. */
const statementNote = (key: string, text: string, secondsAgo: number, replyTo: string[]): SeedMessage => ({
  key,
  mailboxes: ['inbox'],
  from: HARBOUR,
  to: [ME],
  subject: STATEMENT,
  text,
  sentAt: new Date(Date.parse(seed.now) - secondsAgo * 1000).toISOString(),
  replyTo,
  headers: { listUnsubscribe: true, listId: true, precedence: 'bulk' },
  bulk: true,
})

/** Delivers `message` at the provider and waits for the open message to be it. */
async function arrives(page: Page, mailbox: SimMailbox, message: SeedMessage, shows: string) {
  mailbox.deliver(message)
  await page.evaluate(() => window.letterboxDev?.sync())
  await opened(page, -1).locator('[data-field="body"]', { hasText: shows }).waitFor()
}

/** In Updates, a new message in the open conversation takes the open one's place folded. */
export async function checkUpdatesMovesOn(page: Page, mailbox: SimMailbox) {
  await nav(page, 'Updates').click()
  await senderRow(page, HARBOUR.name).click()
  const before = ['html-statement-1', 'html-statement-2']
  const payment = 'Your payment of €42.10 arrived. Thank you.'
  await arrives(
    page,
    mailbox,
    statementNote(
      'statement-paid',
      `${payment}\n\nOn Mon, Mar 9, 2026, Harbour Lane Accounts wrote:\n> Your February statement is ready.`,
      120,
      before,
    ),
    payment,
  )
  await opened(page, -1).locator(LINE).click()
  equal(await opened(page, -1).locator(LINE).getAttribute('aria-expanded'), 'true', 'the payment note’s quote opens')
  const next = 'Your March statement follows on April 1.'
  await arrives(
    page,
    mailbox,
    statementNote('statement-next', `${next}\n\nOn Mon, Mar 9, 2026, Harbour Lane Accounts wrote:\n> ${payment}`, 60, [
      ...before,
      'statement-paid',
    ]),
    next,
  )
  equal(
    await opened(page, -1).locator(LINE).getAttribute('aria-expanded'),
    'false',
    'a new message in the open conversation shows with its quote folded: nothing of the one before carries over',
  )
}
