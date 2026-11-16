// The reply UI check's two ways a reply can come back without all it knew, run inside
// reply.ts while the core holds its waits. A reload that cannot read session storage rebuilds
// a held reply from its message, which keeps no Bcc. A held reply whose conversation the core
// merges into another moves with it: Undo waits while the renderer finds where it went, that
// conversation's draft cannot go meanwhile, and Undo over that draft keeps both until the user picks.

import type { Page } from 'playwright'
import { equal, type Relay, WAIT_MS } from './record.ts'
import {
  body,
  chips,
  dock,
  INVOICE,
  open,
  openWith,
  ROUTE,
  rowWith,
  sendButton,
  sends,
  toast,
  TRIP,
  undos,
} from './reply-page.ts'

/** A reload without session storage: Undo brings the reply back saying its Bcc is gone, and Send waits. */
export async function checkBccAfterReload(page: Page) {
  // A reload that cannot read session storage rebuilds a held reply from its message, which
  // keeps no Bcc. Undo brings it back saying so, and Send waits until the user has looked.
  await open(page, 'Invoice question')
  await page.keyboard.press('r')
  await dock(page).getByRole('button', { name: 'Cc Bcc' }).click()
  await dock(page).locator('input[data-line="bcc"]').fill('ledger@harbourlane.example')
  await body(page).fill(INVOICE)
  await page.keyboard.press('Control+Enter')
  const heldInvoice = page.locator('[data-message="open"][data-delivery="held"]', { hasText: INVOICE })
  await heldInvoice.waitFor()
  await page.evaluate(() => void (window.name = 'no-session-storage'))
  await page.reload()
  await open(page, 'Invoice question')
  await heldInvoice.waitFor()
  await toast(page).getByRole('button', { name: /^Undo/ }).click()
  await heldInvoice.waitFor({ state: 'detached' })
  await dock(page).waitFor()
  const bccNotice = dock(page).locator('[data-field="bcc-notice"]')
  equal(
    [(await bccNotice.count()) === 1 ? await bccNotice.textContent() : '', await sendButton(page).isDisabled()],
    ["Bcc wasn't kept after the reload. Check recipients before sending.", true],
    'a reply rebuilt without its Bcc says so, and Send waits',
  )
  await bccNotice.click()
  equal(
    [await bccNotice.count(), await sendButton(page).isDisabled()],
    [0, false],
    'one click on the notice confirms the recipients, and Send works',
  )
  await dock(page).getByRole('button', { name: 'Discard' }).click()
  await page.evaluate(() => void (window.name = ''))
}

/** A held reply's conversation merges into another that has a draft. */
export async function checkMergedConversation(page: Page, relay: Relay) {
  // A held reply whose conversation the core merges into another. Kit's conversation, where
  // it waits, goes into Owen's, where a draft is open. The user is still on Kit's.
  await page.evaluate(() => window.letterboxDev?.deliver(1))
  await page.getByRole('textbox', { name: 'Search mail' }).fill('trip in May')
  await page.keyboard.press('Enter')
  await rowWith(page, 'trip in May', 'Owen Hale').first().waitFor()
  await openWith(page, 'trip in May', 'Kit Ashworth', 'Are you coming')
  await page.keyboard.press('r')
  await body(page).fill(TRIP)
  await page.keyboard.press('Control+Enter')
  const heldTrip = page.locator('[data-message="open"][data-delivery="held"]', { hasText: TRIP })
  await heldTrip.waitFor()
  await openWith(page, 'trip in May', 'Owen Hale', 'ride to the coast')
  await page.keyboard.press('r')
  await body(page).fill(ROUTE)
  await openWith(page, 'trip in May', 'Kit Ashworth', 'Are you coming')

  // The merge. The renderer looks for where the reply went, and the relay holds the core's
  // answers from that search on. Meanwhile Undo shows, but cannot run.
  const searching = relay.pauseAfterPageSends('Bike trip in May"')
  // Not awaited: the core answers this only after the updates the relay holds.
  const merged = page.evaluate(() => window.letterboxDev?.deliver(1))
  await Promise.race([
    searching,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('the page never searched for the merged reply')), WAIT_MS),
    ),
  ])
  await page.getByText('This conversation is gone').waitFor()
  const undoButton = toast(page).getByRole('button', { name: /^Undo/ })
  const before = undos(relay)
  await page.keyboard.press('z')
  equal(
    [
      await toast(page).locator('[data-field="toast-note"]', { hasText: 'Finding the conversation…' }).count(),
      (await undoButton.count()) === 1 && (await undoButton.isDisabled()),
      undos(relay) - before,
    ],
    [1, true, 0],
    'while the reply is being found, Undo shows but is off, and z sends nothing',
  )
  relay.resume()
  await merged

  // In Owen's conversation the draft stays and can be edited, but cannot go while the held reply waits.
  await openWith(page, 'trip in May', 'Owen Hale', TRIP)
  await heldTrip.waitFor()
  const locked = dock(page).locator('[data-field="send-locked"]')
  equal(
    [
      await body(page).inputValue(),
      await body(page).isEditable(),
      await sendButton(page).isDisabled(),
      /^Your earlier reply is still sending \(\d+ s\)$/.test(
        (await locked.count()) === 1 ? ((await locked.textContent()) ?? '') : '',
      ),
    ],
    [ROUTE, true, true, true],
    'a draft in the conversation the held reply moved into stays editable, with Send off',
  )
  const sent = sends(relay)
  await body(page).press('Control+Enter')
  equal([sends(relay), await body(page).inputValue()], [sent, ROUTE], 'Ctrl+Enter there sends nothing')

  // Undo goes at once, even over a draft with text. The draft stays, and the undone reply waits beside it.
  await body(page).press('Escape')
  await page.keyboard.press('z')
  const notice = dock(page).locator('[data-field="undone-notice"]')
  await page.locator('[data-field="undone-notice"], [data-field="send-problem"]').first().waitFor()
  // The undone reply leaves the thread with the core's update after the undo.
  if ((await notice.count()) === 1) await heldTrip.waitFor({ state: 'detached' })
  equal(
    [
      (await notice.count()) === 1 ? ((await notice.locator('p').textContent()) ?? '') : '',
      await heldTrip.count(),
      await body(page).inputValue(),
    ],
    ['Undid your earlier reply.', 0, ROUTE],
    'Undo over a draft cancels the send at once, keeps the draft, and keeps the undone reply beside it',
  )

  // Restoring it puts it here, in the conversation that holds it now, over the draft.
  await notice.getByRole('button', { name: 'Restore it (replaces this draft)' }).click()
  equal(
    [await body(page).inputValue(), await chips(page, 'to'), await sendButton(page).isDisabled(), await notice.count()],
    [TRIP, ['Kit Ashworth <kit@ashworth.example>'], false, 0],
    'Restore puts the undone reply in the conversation that holds it, and Send works again',
  )
  await dock(page).getByRole('button', { name: 'Discard' }).click()
}
