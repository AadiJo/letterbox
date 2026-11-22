// The forward half of the compose UI check (compose.ts), on its page. Every reply bar has
// Forward with its key F, and Reply all shows its Shift+R. Forward takes the reader like a new
// message: "Fwd:" quiet before the subject, the original's files as chips the user can take
// off, then the original quoted. The draft keeps the files taken off across a reload and an
// undo, the core is told which to leave out, and the provider gets the forward with the rest.

import type { SimMailbox } from '@letterbox/sim-provider/contract'
import { filesOf } from '@letterbox/sim-provider/sent'
import type { Page } from 'playwright'
import {
  captureScene,
  COVER,
  COVER_FILES,
  composePage,
  forwardFiles,
  lineInput,
  pageChips,
  pageOf,
  selectedRows,
  subjectField,
  suggestions,
  text,
} from './compose-page.ts'
import { equal, type Relay, SIZES } from './record.ts'
import { lastSend, nav, open, toast } from './reply-page.ts'

const WRITTEN = [
  'Hi Nadia,',
  'Here’s Priya’s cover for issue 12. Could you check the masthead against the print margins? The printer locks the file on Friday.',
  'Thanks,\nRobin',
].join('\n\n')

const bar = (page: Page) => page.locator('[data-field="reply-bar"]').locator('..')

/** Runs on the page compose.ts left on People. `hold.on` false lets the next core end a send's window. */
export async function checkForward(page: Page, relay: Relay, mailbox: SimMailbox, hold: { on: boolean }) {
  await nav(page, 'People').click()
  await open(page, 'Cover draft for issue 12')

  // The bar: Reply, Reply all with its Shift+R, and Forward with its F, each behind a hairline.
  const forward = page.getByRole('button', { name: 'Forward', exact: true })
  equal(
    await bar(page)
      .getByRole('button')
      .evaluateAll((buttons) =>
        buttons.map((button) => [button.textContent, button.getAttribute('aria-keyshortcuts')]),
      ),
    [
      ['Reply to PriyaR', 'r'],
      ['Reply allShift R', 'Shift+r'],
      ['ForwardF', 'f'],
    ],
    'the reply bar offers Reply, Reply all with Shift+R, and Forward with F',
  )
  // Scrolled to the conversation's end first, as the mock shows it, so the hover moves nothing.
  const atEnd = () =>
    page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>('article [data-scroll]')
      if (scroller) scroller.scrollTop = scroller.scrollHeight
    })
  await captureScene(page, 'forward-b-entry', async () => {
    await atEnd()
    await forward.hover()
  })

  // At 1024 px, scrolled to its end, the conversation leaves 24 px under the reply bar.
  await page.setViewportSize(SIZES.narrow)
  const under = await page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>('article [data-scroll]')
    const replyBar = document.querySelector('[data-field="reply-bar"]')?.parentElement
    if (!scroller || !replyBar) throw new Error('the reader shows no reply bar')
    scroller.scrollTop = scroller.scrollHeight
    return Math.round(scroller.getBoundingClientRect().bottom - replyBar.getBoundingClientRect().bottom)
  })
  equal(under, 24, 'scrolled to its end at 1024 px, the reader leaves 24 px under the reply bar')
  await page.setViewportSize(SIZES.wide)

  // F takes the reader with the forward: the subject after a quiet "Fwd:", the files, the original quoted.
  await page.keyboard.press('f')
  await pageOf(page, 'Forward').waitFor()
  const quoted = composePage(page).locator('[data-field="forwarded-text"] p')
  equal(
    [
      await composePage(page).locator('[data-field="compose-title"]').textContent(),
      await composePage(page).locator('[data-field="subject"]').locator('..').textContent(),
      await subjectField(page).inputValue(),
      await forwardFiles(page),
      await quoted.allTextContents(),
    ],
    ['Forward', 'Fwd:', 'Cover draft for issue 12', COVER_FILES.map((file) => file.name), COVER.text.split('\n\n')],
    'F opens the forward: "Fwd:" before the subject, the original’s files, and its text quoted',
  )
  equal(
    await selectedRows(page).allTextContents(),
    [await page.locator('[role="option"][data-row]', { hasText: 'Cover draft for issue 12' }).first().textContent()],
    'while forwarding, the row it comes from stays selected',
  )
  // A forward whose subject alone was changed is the user's work: C brings it back, not a new message.
  await subjectField(page).fill('Cover draft for issue 12, print check')
  await page.keyboard.press('Escape')
  await page.keyboard.press('c')
  await pageOf(page, 'Forward').waitFor()
  equal(
    await subjectField(page).inputValue(),
    'Cover draft for issue 12, print check',
    'C brings back a forward whose subject was changed, and starts no new message over it',
  )
  await subjectField(page).fill('Cover draft for issue 12')
  await lineInput(page, 'to').click()
  await page.keyboard.type('nad')
  await suggestions(page).getByRole('option').first().waitFor()
  await page.keyboard.press('Enter')
  await text(page).fill(WRITTEN)
  await captureScene(page, 'forward-b-compose')

  // A file taken off stays off, after a reload too.
  await composePage(page)
    .getByRole('button', { name: `Remove ${COVER_FILES[1]?.name}` })
    .click()
  const pdf = [COVER_FILES[0]?.name]
  equal(await forwardFiles(page), pdf, 'X takes a file off the forward')
  await page.reload()
  await pageOf(page, 'Forward').waitFor()
  await composePage(page).locator('[data-field="forward-file"]').first().waitFor()
  equal(
    [await pageChips(page, 'to'), await forwardFiles(page), await text(page).inputValue()],
    [['Nadia Petrov <nadia@petrovprint.test>'], pdf, WRITTEN],
    'after a reload, the forward is up with its people, its text, and the file still off',
  )

  // Send hands the core only what the user wrote, the original, and the file to leave out.
  await text(page).click()
  await page.keyboard.press('Control+Enter')
  await composePage(page).waitFor({ state: 'detached' })
  const sent = lastSend(relay)
  equal(
    sent && [sent.subject, sent.text, sent.inReplyTo, typeof sent.forwardOf, sent.forwardWithout?.length],
    ['Fwd: Cover draft for issue 12', WRITTEN, null, 'string', 1],
    'Send hands the core the forward: the original, the one file left out, and only what the user wrote',
  )
  await toast(page).getByRole('button', { name: /^Undo/, disabled: false }).click()
  await pageOf(page, 'Forward').waitFor()
  await composePage(page).locator('[data-field="forward-file"]').first().waitFor()
  equal(
    [await forwardFiles(page), await text(page).inputValue(), mailbox.calls().send],
    [pdf, WRITTEN, 0],
    'Undo puts the forward back as it was, the file still off, and nothing went out',
  )

  // A core that lets the window pass: the forward goes once, with the one file.
  await text(page).click()
  await page.keyboard.press('Control+Enter')
  await composePage(page).waitFor({ state: 'detached' })
  // While the core holds it, its file shows, with no Open or Save: the provider has no copy yet.
  await nav(page, 'Sent').click()
  await open(page, 'Fwd: Cover draft for issue 12')
  const held = page.locator('[data-message="open"][data-delivery="held"] [data-field="attachment"]')
  await held.first().waitFor()
  equal(
    [await held.count(), await held.getByRole('button').count()],
    [1, 0],
    'a forward the core still holds shows its file, with no Open or Save',
  )
  hold.on = false
  await page.reload()
  await page.locator('[role="listbox"][aria-label="Your turn"] [role="option"]').first().waitFor()
  await nav(page, 'Sent').click()
  await open(page, 'Fwd: Cover draft for issue 12')
  await page.locator('[data-message="open"][data-delivery="delivered"]').waitFor()
  equal(
    await page
      .locator('[data-message="open"][data-delivery="delivered"] [data-field="attachment"]')
      .getByRole('button')
      .allTextContents(),
    ['Open', 'Save'],
    'once the provider holds the forward, its file offers Open and Save',
  )
  const copies = mailbox.sent()
  equal(
    [copies.length, copies[0]?.recipients, filesOf(copies[0]?.raw ?? '').map((file) => file.name)],
    [1, ['nadia@petrovprint.test'], pdf],
    'the provider got the forward once, to Nadia, with the one file left on',
  )
}
