// The reply UI check's two ways a reply can come back without all it knew, run inside
// reply.ts while the core holds its waits. A reload that cannot read session storage rebuilds
// a held reply from its message, which keeps no Bcc. A held reply whose conversation the core
// merges into another moves with it, and that conversation's draft cannot go meanwhile.

import type { Page } from 'playwright'
import { equal, type Relay } from './record.ts'
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
  undoOffered,
} from './reply-page.ts'

/** A reload without session storage: Undo brings the reply back saying its Bcc is gone, and Send waits. */
export async function checkBccAfterReload(page: Page) {
  // A reload that cannot read session storage rebuilds a held reply from its message, which
  // keeps no Bcc. Undo brings it back saying so, and Send waits until the user has looked.
  await open(page, 'Invoice 2291, line 4')
  await page.keyboard.press('r')
  await dock(page).getByRole('button', { name: 'Cc Bcc' }).click()
  await dock(page).locator('input[data-line="bcc"]').fill('ledger@harbourlane.example')
  await body(page).fill(INVOICE)
  await page.keyboard.press('Control+Enter')
  const heldInvoice = page.locator('[data-message="open"][data-delivery="held"]', { hasText: INVOICE })
  await heldInvoice.waitFor()
  await page.evaluate(() => void (window.name = 'no-session-storage'))
  await page.reload()
  await open(page, 'Invoice 2291, line 4')
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
  // With a draft taller than the dock, the notice stays in view above the footer, and the
  // footer says why Send waits. Nothing scrolls it into view first.
  await body(page).fill(`${INVOICE}\n\n${'One more line.\n'.repeat(30)}`)
  const shown = await bccNotice.evaluate((notice) => {
    const box = notice.getBoundingClientRect()
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
    return Boolean(hit && notice.contains(hit))
  })
  equal(
    [shown, await dock(page).locator('footer [role="status"]').textContent()],
    [true, 'Check the recipients before sending'],
    'with a long draft, the Bcc notice stays in view and the footer says why Send waits',
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
  await page.getByRole('textbox', { name: 'Search mail' }).fill('Bike trip')
  await page.keyboard.press('Enter')
  await rowWith(page, 'Bike trip in May', 'Owen Hale').first().waitFor()
  await openWith(page, 'Bike trip in May', 'Kit Ashworth', 'Are you coming')
  await page.keyboard.press('r')
  await body(page).fill(TRIP)
  await page.keyboard.press('Control+Enter')
  const heldTrip = page.locator('[data-message="open"][data-delivery="held"]', { hasText: TRIP })
  await heldTrip.waitFor()
  await openWith(page, 'Bike trip in May', 'Owen Hale', 'ride to the coast')
  await page.keyboard.press('r')
  await body(page).fill(ROUTE)
  await openWith(page, 'Bike trip in May', 'Kit Ashworth', 'Are you coming')
  await page.evaluate(() => window.letterboxDev?.deliver(1))
  await page.getByText('This conversation is gone').waitFor()
  equal(await undoOffered(page), true, 'the held reply still offers Undo after its conversation merged away')

  // In Owen's conversation the draft stays and can be edited, but cannot go while the held reply waits.
  await openWith(page, 'Bike trip in May', 'Owen Hale', TRIP)
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
  const before = sends(relay)
  await body(page).press('Control+Enter')
  equal([sends(relay), await body(page).inputValue()], [before, ROUTE], 'Ctrl+Enter there sends nothing')

  // Undo would bring the held reply back over that draft, so it asks for the draft to go first.
  await body(page).press('Escape')
  await page.keyboard.press('z')
  await dock(page).locator('[data-field="send-problem"]').waitFor()
  equal(
    [await dock(page).locator('[data-field="send-problem"]').textContent(), await heldTrip.count()],
    ['Discard this draft to undo your earlier reply.', 1],
    'Undo over a draft with text keeps both and says what to do',
  )
  await dock(page).getByRole('button', { name: 'Discard' }).click()

  // With the draft gone, R there shows the reply that moved in, read only, and starts no second one.
  await page.keyboard.press('r')
  await dock(page).locator('[data-field="reply-pending"]').waitFor()
  equal(await body(page).isEditable(), false, 'R where the reply moved shows it read only, with no second draft')

  // Then Undo brings the reply back here, in the conversation that now holds it, ready to send.
  await page.keyboard.press('z')
  await heldTrip.waitFor({ state: 'detached' })
  await dock(page).waitFor()
  equal(
    [await body(page).inputValue(), await chips(page, 'to'), await sendButton(page).isDisabled()],
    [TRIP, ['Kit Ashworth <kit@ashworth.example>'], false],
    'Undo restores the reply into the conversation it moved to, and Send works again',
  )
  await dock(page).getByRole('button', { name: 'Discard' }).click()
}
