// The UI checks for undo of Archive and Trash through the core, over done.ts's dev host: z
// brings the row back where it was, trash from Sent keeps its row on a labels account, the
// toast says "Undoing…" until the core answers, and every refused undo says why.

import type { Page } from 'playwright'
import { conversations, mailRows, nav, openInbox, settle, toast, waitForTotal } from './mail-list.ts'
import { equal, type Relay } from './record.ts'

/** Runs every undo check, from Inbox. */
export async function checkUndo(page: Page, relay: Relay) {
  await checkArchiveAndTrashUndo(page)
  await checkTrashFromSent(page)
  await checkUndoing(page, relay)
  await checkRefusals(page, relay)
}

/**
 * The action under `key` on Inbox's first row offers Undo too. z takes the change back
 * through the core, and the row comes back where it was, open, with the count it had.
 */
async function checkUndoOf(page: Page, key: string, label: string) {
  const total = await conversations(page)
  const before = await mailRows(page).evaluateAll((rows) => rows.map((row) => row.getAttribute('data-row')))
  const [id] = before
  if (!id) throw new Error('Inbox shows no conversation')
  await mailRows(page).first().click()
  await page.keyboard.press(key)
  await toast(page).filter({ hasText: label }).waitFor()
  equal(await toast(page).getByRole('button', { name: /^Undo/ }).count(), 1, `"${label}" offers Undo`)
  await page.locator(`[data-list="mail"] [data-row="${id}"]`).waitFor({ state: 'detached' })
  await waitForTotal(page, total - 1)
  await page.keyboard.press('z')
  await page.locator(`[data-list="mail"] [data-row="${id}"][aria-selected="true"]`).waitFor()
  await waitForTotal(page, total)
  // The window may have filled in more rows meanwhile. The rows both readings hold must match.
  const after = await mailRows(page).evaluateAll((rows) => rows.map((row) => row.getAttribute('data-row')))
  const shared = Math.min(before.length, after.length)
  equal(after.slice(0, shared), before.slice(0, shared), `${label}: z brings the row back where it was, open`)
  equal(await conversations(page), total, `${label}: z restores the Inbox count`)
  equal(await toast(page).count(), 0, `${label}: z takes the toast down`)
}

/** Archive and Trash offer the same undo as Done, and Trash in Trash moves nothing. */
async function checkArchiveAndTrashUndo(page: Page) {
  await openInbox(page)
  await checkUndoOf(page, 'e', 'Archived')
  await checkUndoOf(page, '#', 'Moved to Trash')

  // Trash on a conversation already in Trash changes nothing there, so its row stays put.
  const trashed = await mailRows(page).first().getAttribute('data-row')
  await mailRows(page).first().click()
  await page.keyboard.press('#')
  await toast(page).filter({ hasText: 'Moved to Trash' }).waitFor()
  await page.locator(`[data-row="${trashed}"]`).waitFor({ state: 'detached' })
  await nav(page, 'Trash').click()
  const inTrash = page.locator(`[data-list="mail"] [data-row="${trashed}"]`)
  await inTrash.locator('[data-field="subject"]').waitFor()
  await inTrash.click()
  await page.keyboard.press('#')
  await settle(page)
  equal(await inTrash.evaluate((row) => row.getAnimations().length), 0, 'trash in Trash leaves the row where it is')
}

/**
 * Trash on a labels account keeps Sent, as the core does, so trash from Sent keeps its row,
 * whole and still. Undo then shows it as it was, even once any exit has ended.
 */
async function checkTrashFromSent(page: Page) {
  await nav(page, 'Sent').click()
  await mailRows(page).first().locator('[data-field="subject"]').waitFor()
  const total = await conversations(page)
  const id = await mailRows(page).first().getAttribute('data-row')
  const row = page.locator(`[data-list="mail"] [data-row="${id}"]`)
  const looks = () =>
    row.evaluate((element) => ({
      moving: element.getAnimations().length,
      shown: element.getBoundingClientRect().height > 0 && getComputedStyle(element).opacity === '1',
    }))
  await row.click()
  await page.keyboard.press('#')
  await toast(page).filter({ hasText: 'Moved to Trash' }).waitFor()
  await settle(page)
  equal(await looks(), { moving: 0, shown: true }, 'trash from Sent keeps the row, whole and still')
  equal(await conversations(page), total, 'trash from Sent keeps the Sent count')
  // Lets any exit run to its end, so the undo below finds it ended.
  await row.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)))
  await page.keyboard.press('z')
  await toast(page).waitFor({ state: 'detached' })
  await settle(page)
  equal(await looks(), { moving: 0, shown: true }, 'undo after trash shows the row as it was')
}

/** Archives Inbox's first row and waits for its toast. */
async function archiveFirst(page: Page) {
  await mailRows(page).first().click()
  await page.keyboard.press('e')
  await toast(page).filter({ hasText: 'Archived' }).waitFor()
}

/** z while the core has not answered the undo shows "Undoing…", with Undo in place, until it does. */
async function checkUndoing(page: Page, relay: Relay) {
  await openInbox(page)
  const id = await mailRows(page).first().getAttribute('data-row')
  await archiveFirst(page)
  const paused = relay.pauseAtAccepted()
  await page.keyboard.press('z')
  await paused
  equal(
    await toast(page).locator('[data-field="toast"]').textContent(),
    'Undoing…',
    'z says "Undoing…" until the core answers',
  )
  equal(
    await toast(page).getByRole('button', { name: /^Undo/ }).count(),
    1,
    'Undo stays in place while the core decides',
  )
  relay.resume()
  await page.locator(`[data-list="mail"] [data-row="${id}"][aria-selected="true"]`).waitFor()
  await toast(page).waitFor({ state: 'detached' })
}

/** Archives Inbox's first row, has the relay refuse its undo with `conflict`, and reads the toast. */
async function refusalSays(page: Page, relay: Relay, conflict: unknown) {
  await archiveFirst(page)
  relay.refuseNextUndo(conflict)
  await page.keyboard.press('z')
  const said = toast(page).locator('[data-field="toast"]')
  await page.waitForFunction(() => document.querySelector('[data-field="toast"]')?.textContent !== 'Undoing…')
  return { text: await said.textContent(), undo: await toast(page).getByRole('button', { name: /^Undo/ }).count() }
}

/** Every refused undo says why in the toast, naming the mailbox the core names. */
async function checkRefusals(page: Page, relay: Relay) {
  await openInbox(page)
  const plain = await refusalSays(page, relay, undefined)
  equal(plain, { text: "This can't be undone", undo: 0 }, 'a refused undo with no reason says it cannot be undone')
  // The archive the page just sent names Inbox, the mailbox it takes the conversation out of.
  const sent = relay.fromPage().map((text) => JSON.parse(text) as { command?: { kind?: string; remove?: string[] } })
  const inbox = sent.findLast((message) => message.command?.kind === 'set-mailboxes')?.command?.remove?.[0]
  if (!inbox) throw new Error('the archive named no mailbox to take the conversation out of')
  const field = { kind: 'mailbox', messageId: 'message_1', mailboxId: inbox }
  equal(
    (await refusalSays(page, relay, { kind: 'changed', field })).text,
    "Its place in Inbox changed since, so it can't be undone",
    'a change since names the field and its mailbox',
  )
  equal(
    (await refusalSays(page, relay, { kind: 'changed', field: { kind: 'flagged', messageId: 'message_1' } })).text,
    "Its flag changed since, so it can't be undone",
    'a change since names the field',
  )
  equal(
    (await refusalSays(page, relay, { kind: 'mailbox-gone', mailboxId: inbox })).text,
    "Inbox is gone, so it can't be undone",
    'a mailbox that is gone is named',
  )
  equal(
    (await refusalSays(page, relay, { kind: 'partly-applied', field })).text,
    "Only part of this went through, so it can't be undone",
    'a partly applied change says only part went through',
  )
  const unknown = await refusalSays(page, relay, { kind: 'outcome-unknown' })
  equal(unknown.text?.startsWith("Can't undo yet: waiting for "), true, 'an unconfirmed change says undo must wait')
}
