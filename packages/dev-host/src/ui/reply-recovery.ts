// The reply UI check's ways a reply can come back without all it knew, run inside reply.ts
// while the core holds its waits. A reload that cannot read session storage rebuilds a held
// reply from its message, which keeps no Bcc. A held reply whose conversation the core merges
// into another moves with it: Undo waits while the renderer finds where it went, that
// conversation's draft cannot go meanwhile, and Undo over that draft keeps both until the user
// picks. An undo the core accepts, whose answer never reaches the page, keeps the reply's text:
// the toast says "Undoing…", and after a reload the reply is back in its editor once the core
// answers again. Two undos at once send one.

import type { Page } from 'playwright'
import { draftText } from './dock.ts'
import { settle } from './mail-list.ts'
import { capture, equal, type Relay, WAIT_MS } from './record.ts'
import {
  body,
  chips,
  dock,
  INVOICE,
  LEASE,
  nav,
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

const LEASE_SUBJECT = 'Lease addendum for 4B'

/** Sends LEASE from the People screen and waits until the conversation shows it held. */
async function sendLease(page: Page) {
  await nav(page, 'People').click()
  await open(page, LEASE_SUBJECT)
  await page.keyboard.press('r')
  await body(page).fill(LEASE)
  await page.keyboard.press('Control+Enter')
  await page.locator('[data-message="open"][data-delivery="held"]', { hasText: LEASE }).waitFor()
}

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
  // Session storage works again from the next load on.
  await page.reload()
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
  // Beside the draft, or alone in the dock once no draft is left.
  const notice = page.locator('[data-field="undone-notice"]')
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

  // The draft goes, and while the core has not answered it cannot be replaced: Restore is off
  // and the undone reply stays.
  const answering = relay.pauseAtAccepted()
  await body(page).press('Control+Enter')
  await answering
  const restoreButton = notice.getByRole('button', { name: /^Restore it/ })
  equal(
    [await notice.count(), await restoreButton.isDisabled()],
    [1, true],
    'while the draft waits on the core, Restore is off and the undone reply stays',
  )
  relay.resume()
  const heldRoute = page.locator('[data-message="open"][data-delivery="held"]', { hasText: ROUTE })
  await heldRoute.waitFor()

  // Two reloads with the undone reply and a held send both in storage. Neither is lost.
  await page.reload()
  await page.reload()
  await page.getByRole('textbox', { name: 'Search mail' }).fill('trip in May')
  await page.keyboard.press('Enter')
  await openWith(page, 'trip in May', 'Owen Hale', ROUTE)
  await heldRoute.waitFor()
  equal(await notice.count(), 1, 'after two reloads the undone reply is still kept beside the held send')

  // Restoring it puts it here, in the conversation that holds it now.
  await restoreButton.click()
  equal(
    [await body(page).inputValue(), await chips(page, 'to'), await notice.count()],
    [TRIP, ['Kit Ashworth <kit@ashworth.example>'], 0],
    'Restore puts the undone reply in the conversation that holds it',
  )
  // Both taken back and thrown away, so the provider never gets either.
  await body(page).press('Escape')
  await page.keyboard.press('z')
  await heldRoute.waitFor({ state: 'detached' })
  await notice.getByRole('button', { name: 'Discard it' }).click()
  await dock(page).getByRole('button', { name: 'Discard' }).click()
}

/**
 * The core accepts an undo of a held reply, and its answer never reaches the page: first the
 * connection drops, then the answer alone is lost. Either way the toast says "Undoing…" and
 * the text stays kept. After a reload, the page asks the core again under the same undo, and
 * the reply is back in its editor.
 */
export async function checkUndoAnswerLost(page: Page, relay: Relay) {
  const subject = LEASE_SUBJECT
  const held = page.locator('[data-message="open"][data-delivery="held"]', { hasText: LEASE })
  const said = () => toast(page).locator('[data-field="toast"]').textContent()
  /** The conversation's editor (null without one), its held reply, and whether the toast says Undoing…. */
  const looks = async () => ({
    text: (await dock(page).count()) === 1 ? await draftText(page) : null,
    held: await held.count(),
    undoing: await toast(page).filter({ hasText: 'Undoing…' }).count(),
  })
  /**
   * Reloads with the core's answer to the undo the page sends again held, and reads the
   * conversation before and after that answer arrives. The text waits for the answer.
   */
  const afterReload = async () => {
    const replayed = relay.holdNextUndoAnswer()
    await page.reload()
    await replayed
    await nav(page, 'People').click()
    await open(page, subject)
    await settle(page)
    const before = await looks()
    relay.releaseUndoAnswer()
    await dock(page).waitFor()
    return { before, after: await looks() }
  }
  const restored = {
    before: { text: null, held: 0, undoing: 1 },
    after: { text: LEASE, held: 0, undoing: 0 },
  }

  // The connection drops after the core accepted the undo, before its answer reached the page.
  await sendLease(page)
  const accepted = relay.pauseAtAccepted()
  await toast(page).getByRole('button', { name: /^Undo/ }).click()
  await accepted
  await relay.drop()
  await page.getByRole('alert').waitFor()
  equal(await said(), 'Undoing…', 'an undo whose answer the dropped connection lost says Undoing…')
  await capture(page, 'reply-undo-lost')
  equal(
    await afterReload(),
    restored,
    'after a reload, the reply comes back to its editor once the core answers the undo again',
  )
  await capture(page, 'reply-undo-lost-restored')
  await dock(page).getByRole('button', { name: 'Discard' }).click()

  // The answer alone is lost, and the connection stays. The core's update takes the reply out of
  // the conversation, and the text stays kept until the core says the undo went through.
  await sendLease(page)
  const lost = relay.holdNextUndoAnswer()
  await page.keyboard.press('z')
  await lost
  await held.waitFor({ state: 'detached' })
  await settle(page)
  equal(
    [(await toast(page).count()) === 1 ? await said() : null, await dock(page).count()],
    ['Undoing…', 0],
    'an undo whose answer is lost says Undoing… once the reply has left the conversation',
  )
  await capture(page, 'reply-undo-unanswered')
  equal(
    await afterReload(),
    restored,
    'after a reload, the undo whose answer was lost puts the reply back once the core answers again',
  )
  await dock(page).getByRole('button', { name: 'Discard' }).click()
}

/**
 * The toast's Undo and z in the same tick, on a held reply. One undo reaches the core, the
 * reply comes back once, and nothing says it is too late.
 */
export async function checkDoubleUndo(page: Page, relay: Relay) {
  await sendLease(page)
  const before = undos(relay)
  await page.evaluate(() => {
    const status = [...document.querySelectorAll('[role="status"]')].find((element) =>
      element.querySelector('[data-field="toast"]'),
    )
    const button = status?.querySelector('button')
    if (!button) throw new Error('the toast offers no Undo')
    button.click()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', bubbles: true }))
  })
  await dock(page).waitFor()
  await settle(page)
  equal(
    {
      undos: undos(relay) - before,
      text: await draftText(page),
      kept: await page.locator('[data-field="undone-notice"]').count(),
      tooLate: await toast(page).filter({ hasText: 'Too late' }).count(),
    },
    { undos: 1, text: LEASE, kept: 0, tooLate: 0 },
    'Undo and z at once send one undo, and the reply comes back once',
  )
  await dock(page).getByRole('button', { name: 'Discard' }).click()
}
