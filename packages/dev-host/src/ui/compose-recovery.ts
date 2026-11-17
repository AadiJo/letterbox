// The compose UI check's reloads (compose.ts runs them). A new message's send is kept across a
// reload like a reply's, while its answer is lost (Checking) and while the renderer is still
// finding the conversation it started, when its stored row names no conversation. Meanwhile
// the toast says it is finding it. A reload that cannot read session storage rebuilds a held
// new message from the conversation, and Undo puts it back on the compose page.

import type { SimMailbox } from '@letterbox/sim-provider/contract'
import type { Page } from 'playwright'
import { composePage, lineInput, pageChips, pageOf, subjectField, text } from './compose-page.ts'
import { equal, type Relay } from './record.ts'
import { nav, open, toast } from './reply-page.ts'

const ADDRESS = 'owen.hale@studiohale.test'
const OWEN = `Owen Hale <${ADDRESS}>`

/** Starts a new message to Owen saying `said`, under the subject `subject`, and leaves the cursor in its text. */
async function write(page: Page, subject: string, said: string) {
  await page.keyboard.press('c')
  await pageOf(page, 'New message').waitFor()
  await lineInput(page, 'to').fill(`${OWEN},`)
  await subjectField(page).fill(subject)
  await text(page).fill(said)
}

/** The rows the renderer keeps for the next load, as `[phase, threadId]`. */
const storedRows = (page: Page) =>
  page.evaluate(() =>
    (JSON.parse(sessionStorage.getItem('letterbox.sends') ?? '[]') as { phase: string; threadId: string | null }[]).map(
      (row) => [row.phase, row.threadId],
    ),
  )

const undoButton = (page: Page) => toast(page).getByRole('button', { name: /^Undo/, disabled: false })

/** Whether the toast offers Undo within a few seconds. */
const offersUndo = async (page: Page) =>
  undoButton(page)
    .waitFor({ timeout: 5000 })
    .then(() => true)
    .catch(() => false)

/** Undoes the send the toast offers, and returns what the page then holds. */
async function undoBack(page: Page) {
  await undoButton(page).click()
  await pageOf(page, 'New message').waitFor()
  return [await pageChips(page, 'to'), await subjectField(page).inputValue(), await text(page).inputValue()]
}

/** Throws away the page's draft. */
async function discard(page: Page) {
  await composePage(page).getByRole('button', { name: 'Discard' }).click()
  await composePage(page).waitFor({ state: 'detached' })
}

export async function checkComposeRecovery(page: Page, relay: Relay, mailbox: SimMailbox) {
  // The answer to Send is lost: the page says Checking, and a reload asks the core again.
  const lost = { subject: 'Studio keys', said: 'The spare keys are with the front desk.' }
  await write(page, lost.subject, lost.said)
  const accepted = relay.pauseAtAccepted()
  await page.keyboard.press('Control+Enter')
  await accepted
  await relay.drop()
  await composePage(page).locator('[data-field="send-checking"]').waitFor()
  equal(
    await storedRows(page),
    [['unknown', null]],
    'a new message whose answer is lost is stored, with no conversation',
  )
  await page.reload()
  equal(await offersUndo(page), true, 'after a reload the core is asked again, and the toast offers Undo')
  equal(
    await undoBack(page),
    [[OWEN], lost.subject, lost.said],
    'Undo puts the message whose answer was lost back on the page',
  )
  await discard(page)

  // Accepted, and the conversation it started not found yet: its row names no conversation, and
  // a reload keeps following it.
  const finding = { subject: 'Lamp for the studio', said: 'I found a lamp that would suit the studio.' }
  await write(page, finding.subject, finding.said)
  const looking = relay.pauseAfterPageSends('"query":{"view":"change"')
  await page.keyboard.press('Control+Enter')
  await looking
  equal(
    await storedRows(page),
    [['followed', null]],
    'an accepted new message is stored with no conversation until it is found',
  )
  // The core's answer to where it is is lost with the connection.
  await relay.drop()
  await page.reload()
  equal(await offersUndo(page), true, 'after a reload it is found, and the toast offers Undo')
  equal(await undoBack(page), [[OWEN], finding.subject, finding.said], 'Undo puts it back on the page')
  await discard(page)

  // While it is being found, the toast says so and Undo waits. Then Undo is offered.
  const looked = { subject: 'Plinth for the vase', said: 'The plinth is ready for the vase.' }
  await write(page, looked.subject, looked.said)
  const held = relay.pauseAfterPageSends('"query":{"view":"change"')
  await page.keyboard.press('Control+Enter')
  await held
  equal(
    [
      await toast(page).locator('[data-field="toast-note"]').textContent(),
      await toast(page).getByRole('button', { name: /^Undo/ }).isDisabled(),
    ],
    ['Finding the conversation…', true],
    'until then the toast says it is finding the conversation, and Undo waits',
  )
  relay.resume()
  equal(await offersUndo(page), true, 'once found, the toast offers Undo')
  equal(await undoBack(page), [[OWEN], looked.subject, looked.said], 'and Undo puts it back on the page')
  await discard(page)

  // No session storage on the next load: the held message is rebuilt from its conversation.
  const rebuilt = { subject: 'Frames for the prints', said: 'The frames came in today.' }
  await write(page, rebuilt.subject, rebuilt.said)
  await page.keyboard.press('Control+Enter')
  await undoButton(page).waitFor()
  await page.evaluate(() => {
    window.name = 'no-session-storage'
  })
  await page.reload()
  await nav(page, 'Sent').click()
  await open(page, rebuilt.subject)
  equal(
    await undoBack(page),
    [[ADDRESS], rebuilt.subject, rebuilt.said],
    'without session storage, Undo rebuilds the held new message on the page from its conversation',
  )
  equal(
    await composePage(page).locator('[data-field="bcc-notice"]').count(),
    1,
    'and says its Bcc was not kept, as a rebuilt reply does',
  )
  equal(mailbox.calls().send, 0, 'none of these went out')
  await discard(page)
  await page.evaluate(() => {
    window.name = ''
  })
  await page.reload()
}
