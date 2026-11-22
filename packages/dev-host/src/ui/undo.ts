// The UI checks for undo of Archive and Trash through the core, over done.ts's dev host: z
// brings the row back where it was, trash from Sent keeps its row on a labels account, the
// toast says "Undoing…" until the core answers, z during a row's exit brings that conversation
// back open, every refused undo says why, and an undo whose answer a lost connection kept says
// only that it may or may not have gone through. With the connection lost, each toast sits
// above the lost-core strip, readable (lost-core.ts).

import type { Page } from 'playwright'
import { conversations, mailRows, nav, openInbox, settle, toast, waitForTotal } from './mail-list.ts'
import { toastBesideStrip } from './lost-core.ts'
import { capture, equal, type Relay } from './record.ts'

/** Runs every undo check, from Inbox. */
export async function checkUndo(page: Page, relay: Relay) {
  await checkArchiveAndTrashUndo(page)
  await checkTrashFromSent(page)
  await checkUndoing(page, relay)
  await checkUndoDuringExit(page, relay)
  await checkRefusals(page, relay)
  await checkLostConnection(page, relay)
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

/**
 * Archives Inbox's first row, and waits for its toast and for the row to leave the list. A row
 * still on its way out is the first row, so the next click would open it again.
 */
async function archiveFirst(page: Page) {
  const id = await mailRows(page).first().getAttribute('data-row')
  await mailRows(page).first().click()
  await page.keyboard.press('e')
  await toast(page).filter({ hasText: 'Archived' }).waitFor()
  await page.locator(`[data-list="mail"] [data-row="${id}"]`).waitFor({ state: 'detached' })
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

/** The ids of the rows the mail list shows as open. */
const openRows = (page: Page) =>
  page.locator('[data-list="mail"] [aria-selected="true"]').evaluateAll((rows) => rows.map((row) => row.dataset['row']))

/**
 * z while the archived row is still on its way out, with the core's answer held until the exit
 * has ended. The exit would open the next row as the row folds, but z counts as moving on: once
 * the core accepts, the conversation is back and open. The check sets the order itself. It
 * pauses the row's slide the frame it starts, presses z, and holds the core's answer. Then it
 * lets the exit run to its end, and only then hands the page the answer.
 */
async function checkUndoDuringExit(page: Page, relay: Relay) {
  await openInbox(page)
  const id = await mailRows(page).first().getAttribute('data-row')
  if (!id) throw new Error('Inbox shows no conversation')
  await mailRows(page).first().click()
  await page.keyboard.press('e')
  // Pauses the slide in the frame it starts, so z lands while the row is still leaving.
  await page.waitForFunction(
    (row) => {
      const slide = document.querySelector(`[data-list="mail"] [data-row="${row}"]`)?.getAnimations() ?? []
      slide.forEach((animation) => animation.pause())
      return slide.length > 0
    },
    id,
    { polling: 'raf' },
  )
  const paused = relay.pauseAtAccepted()
  await page.keyboard.press('z')
  await paused
  const leaving = page.locator(`[data-list="mail"] [data-row="${id}"]`)
  await leaving.evaluate((row) => row.getAnimations().forEach((animation) => animation.play()))
  // Gone from the list once its slide and fold have ended, so the exit has done all it does.
  await leaving.waitFor({ state: 'detached' })
  relay.resume()
  await toast(page).waitFor({ state: 'detached' })
  await leaving.waitFor()
  await settle(page)
  equal(
    await openRows(page),
    [id],
    'z during an exit, answered once the exit has ended, brings the conversation back open, not the next one',
  )
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

/** What the toast says when the core's answer to an undo never came (apps/desktop/renderer/src/undo.ts). */
const UNANSWERED = 'Lost the connection. The undo may or may not have gone through'
/** What the toast says when the connection was gone before the undo could be sent. */
const NOT_UNDONE = "Lost the connection, so this wasn't undone"
/** How many undo commands the page has sent its cores. */
const undos = (relay: Relay) => relay.fromPage().filter((text) => text.includes('"kind":"undo"')).length

/** Archives Inbox's open row and waits until it has left, and the next one has opened. Returns its id. */
async function archiveAndWait(page: Page) {
  // Every archive here waits for its row to leave, so the first row is one still in Inbox.
  await mailRows(page).first().click()
  const archived = await page.locator('[data-list="mail"] [aria-selected="true"]').getAttribute('data-row')
  if (!archived) throw new Error('Inbox opened no conversation')
  await page.keyboard.press('e')
  await toast(page).filter({ hasText: 'Archived' }).waitFor()
  // The next conversation opens as the row folds away, which needs the connection.
  await page.locator(`[data-list="mail"] [data-row="${archived}"]`).waitFor({ state: 'detached' })
  await settle(page)
  return archived
}

/** Reads the toast once z's undo has an outcome. */
async function toastAfterUndo(page: Page) {
  await page.waitForFunction(() => document.querySelector('[data-field="toast"]')?.textContent !== 'Undoing…')
  return {
    text: await toast(page).locator('[data-field="toast"]').textContent(),
    undo: await toast(page).getByRole('button', { name: /^Undo/ }).count(),
  }
}

/** Reloads, which connects to a new core, and says whether Inbox shows the conversation `id`. */
async function inInboxAfterReload(page: Page, id: string) {
  await page.reload()
  await openInbox(page)
  await settle(page)
  return (await page.locator(`[data-list="mail"] [data-row="${id}"]`).count()) === 1
}

/**
 * The connection ends before the core's answer to an undo reaches the page. The toast says only
 * what is known: the undo may or may not have gone through. Both happen. The core accepts one
 * undo before the connection drops, so the conversation is back after a reload. Another never
 * reaches the core, so it stays archived. With the connection gone before z, nothing is sent,
 * and the toast says it was not undone.
 */
async function checkLostConnection(page: Page, relay: Relay) {
  await openInbox(page)
  const undone = await archiveAndWait(page)
  const accepted = relay.pauseAtAccepted()
  await page.keyboard.press('z')
  await accepted
  await relay.drop()
  equal(
    await toastAfterUndo(page),
    { text: UNANSWERED, undo: 0 },
    'an undo the core accepted, whose answer the lost connection kept, says the outcome is not known',
  )
  equal(
    await toastBesideStrip(page),
    { gap: 12, readable: true },
    `"${UNANSWERED}" sits 12 px above the lost-core strip, readable`,
  )
  await capture(page, 'undo-lost-connection')
  equal(await inInboxAfterReload(page, undone), true, 'after a reload, that undo shows as done: the row is back')

  const kept = await archiveAndWait(page)
  relay.failNextUndo()
  await page.keyboard.press('z')
  equal(
    await toastAfterUndo(page),
    { text: UNANSWERED, undo: 0 },
    'an undo the lost connection kept from the core says the same',
  )
  equal(await inInboxAfterReload(page, kept), false, 'after a reload, that change stands: the row stays archived')

  // The connection is gone before z, while the toast still offers Undo. Nothing is sent.
  const archived = await archiveAndWait(page)
  await relay.drop()
  await page.locator('[data-field="lost-core"]').waitFor()
  const before = undos(relay)
  equal(
    await toast(page).getByRole('button', { name: /^Undo/ }).count(),
    1,
    'after the drop the toast still offers Undo',
  )
  await page.keyboard.press('z')
  equal(
    [await toastAfterUndo(page), undos(relay) - before],
    [{ text: NOT_UNDONE, undo: 0 }, 0],
    'z with the connection already lost sends nothing, and says it was not undone',
  )
  equal(
    await toastBesideStrip(page),
    { gap: 12, readable: true },
    `"${NOT_UNDONE}" sits 12 px above the lost-core strip, readable`,
  )
  equal(await inInboxAfterReload(page, archived), false, 'after a reload, that change stands too')
}
