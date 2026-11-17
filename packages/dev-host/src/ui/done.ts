// The UI check for the reader's layout and the done states, over a `people-first` dev host
// of its own: the reader fills a 1920 px pane, Done slides the row out with an undo toast and
// z brings it back, archive and Trash offer the same undo through the core, trash from Sent
// keeps its row on a labels account, an undo says "Undoing…" until the core answers and why
// when it is refused, a late answer or a scroll moves no row it should not, an empty Your
// turn says so, and reduced motion is instant.

import type { Browser, Page } from 'playwright'
import { appErrors, capture, equal, openPage, type Relay, SIZES, WAIT_MS } from './record.ts'

const yourTurn = (page: Page) => page.locator('[role="listbox"][aria-label="Your turn"] [role="option"]')
const rowIds = (page: Page) => yourTurn(page).evaluateAll((rows) => rows.map((row) => row.getAttribute('data-row')))
const count = (page: Page) => page.locator('section[aria-label="Your turn"] [data-field="count"]').textContent()
const selectedId = (page: Page) => page.locator('[role="option"][aria-selected="true"]').getAttribute('data-row')
const toast = (page: Page) => page.getByRole('status').filter({ has: page.locator('[data-field="toast"]') })
const nav = (page: Page, name: string) =>
  page.getByRole('navigation', { name: 'Sidebar' }).getByRole('button', { name: new RegExp(`^${name}`) })

/**
 * Resolves, once the Your turn count next changes, with whether row `id` is still in the
 * page at that moment. With motion the row is still sliding out; without, it went in the
 * same update that lowered the count. No timer decides either.
 */
const rowWhenCountDrops = (page: Page, id: string) =>
  page.evaluate(
    (row) =>
      new Promise<boolean>((resolve) => {
        const section = document.querySelector('section[aria-label="Your turn"]')
        const read = () => section?.querySelector('[data-field="count"]')?.textContent
        if (!section) throw new Error('People has no Your turn section')
        const before = read()
        const observer = new MutationObserver(() => {
          if (read() === before) return
          observer.disconnect()
          resolve(document.querySelector(`[data-row="${row}"]`) !== null)
        })
        observer.observe(section, { childList: true, subtree: true, characterData: true })
      }),
    id,
  )

/** At 1920 px the reader fills its pane: toolbar and messages 40 px in from each side, plain text capped near 72ch. */
async function checkReaderLayout(page: Page) {
  await page.setViewportSize(SIZES.full)
  await yourTurn(page).first().click()
  await page.locator('[data-message="open"] [data-field="body"] p').first().waitFor()
  const box = async (selector: string) => {
    const found = await page.locator(selector).first().boundingBox()
    if (!found) throw new Error(`the reader shows no ${selector}`)
    return { left: found.x, right: found.x + found.width, width: found.width }
  }
  const pane = await box('section[aria-label="Reader"]')
  const paragraph = await box('[data-message="open"] [data-field="body"] p')
  // 72ch in the paragraph's own font.
  const measure = await page
    .locator('[data-message="open"] [data-field="body"] p')
    .first()
    .evaluate((element) => {
      const ruler = document.createElement('span')
      ruler.style.cssText = 'position:absolute;width:72ch;height:0'
      element.append(ruler)
      const width = ruler.getBoundingClientRect().width
      ruler.remove()
      return width
    })
  const scrollbar = await page
    .locator('article[aria-label="Conversation"] > div')
    .evaluate((element) => element.getBoundingClientRect().width - element.clientWidth)
  const layout = {
    leftGap: (await box('section[aria-label="Reader"] button[title^="Done"]')).left - pane.left,
    searchGap: pane.right - (await box('section[aria-label="Reader"] form[role="search"]')).right,
    timeGap: pane.right - (await box('[data-message="open"] [data-field="message-time"]')).right,
    scrollbar,
    paragraph: paragraph.width,
    paragraphLeft: paragraph.left,
    bodyLeft: (await box('[data-message="open"] [data-field="body"]')).left,
    measure,
  }
  equal(layout.leftGap <= 40, true, `1920 px: Done sits at the pane's left edge (${layout.leftGap} px in)`)
  equal(layout.searchGap <= 40, true, `1920 px: search sits at the pane's right edge (${layout.searchGap} px in)`)
  equal(
    layout.timeGap <= 40 + layout.scrollbar,
    true,
    `1920 px: the message time lines up with the same right margin (${layout.timeGap} px in)`,
  )
  equal(
    Math.abs(layout.paragraph - layout.measure) < 1,
    true,
    `1920 px: a plain-text paragraph is capped at 72ch (${Math.round(layout.paragraph)} px of ${Math.round(layout.measure)} px)`,
  )
  equal(layout.paragraphLeft, layout.bodyLeft, '1920 px: the capped paragraph stays left-aligned')
  await capture(page, 'reader')
}

/** Done: the row slides out with a toast, the next one opens, and z puts it back, open. */
async function checkDoneAndUndo(page: Page) {
  const before = await rowIds(page)
  const [first, second] = before
  if (!first || !second) throw new Error('Your turn shows fewer than two conversations')
  await page.locator(`[data-row="${first}"]`).click()
  const stillThere = rowWhenCountDrops(page, first)
  await page.keyboard.press('d')
  equal(await stillThere, true, 'Done: the row is still sliding out when the count drops')
  await toast(page).waitFor()
  equal(await toast(page).locator('[data-field="toast"]').textContent(), 'Marked done', 'Done shows "Marked done"')
  await page.locator(`[data-row="${first}"]`).waitFor({ state: 'detached' })
  equal(await count(page), `${before.length - 1}`, 'Done lowers the Your turn count')
  equal(await selectedId(page), second, 'the next conversation opens as the row folds')

  // z before any screenshot, so the toast's 5 s cannot run out first on a slow machine.
  await page.keyboard.press('z')
  await page.locator(`[data-row="${first}"][aria-selected="true"]`).waitFor()
  equal(await rowIds(page), before, 'z brings the row back where it was')
  equal(await count(page), `${before.length}`, 'z restores the Your turn count')
  equal(await toast(page).count(), 0, 'z takes the toast down')

  // Done again, for the picture.
  await page.keyboard.press('d')
  await toast(page).waitFor()
  await capture(page, 'done-toast')
}

/** Resolves once the core has answered everything the page sent, and the page any reaction to that. */
const settle = async (page: Page) => {
  await page.evaluate(() => window.letterboxDev?.settle())
  await page.evaluate(() => window.letterboxDev?.settle())
}

const mailRows = (page: Page) => page.locator('[data-list="mail"] [role="option"]')
const conversations = async (page: Page) =>
  Number.parseInt((await page.locator('[data-field="subtitle"]').textContent()) ?? '', 10)

/** Waits for a mail list's header to count `total` conversations. */
const waitForTotal = (page: Page, total: number) =>
  page.waitForFunction(
    (expected) => document.querySelector('[data-field="subtitle"]')?.textContent === `${expected} conversations`,
    total,
  )

/** Opens Inbox and waits for its rows. */
async function openInbox(page: Page) {
  await nav(page, 'Inbox').click()
  await mailRows(page).first().locator('[data-field="subject"]').waitFor()
}

/** An archive the core accepts after the user left Inbox moves nothing and says nothing where they went. */
/** Opens Inbox on a conversation both lists show at once: in Inbox, and among All mail's first rows. */
async function openSharedRow(page: Page) {
  await nav(page, 'All mail').click()
  await mailRows(page).first().locator('[data-field="subject"]').waitFor()
  const inAllMail = await mailRows(page).evaluateAll((rows) => rows.map((row) => row.getAttribute('data-row')))
  await openInbox(page)
  const inInbox = await mailRows(page).evaluateAll((rows) => rows.map((row) => row.getAttribute('data-row')))
  const id = inInbox.find((candidate) => inAllMail.includes(candidate))
  if (!id) throw new Error('no conversation shows in Inbox and at the top of All mail')
  await page.locator(`[data-list="mail"] [data-row="${id}"]`).click()
  return id
}

async function checkLateArchive(page: Page, relay: Relay) {
  const id = await openSharedRow(page)
  const total = await conversations(page)
  const paused = relay.pauseAtAccepted()
  await page.keyboard.press('e')
  await paused
  await nav(page, 'All mail').click()
  const there = page.locator(`[data-list="mail"] [data-row="${id}"]`)
  await there.locator('[data-field="subject"]').waitFor()
  relay.resume()
  await settle(page)
  equal(
    await there.evaluate((row) => row.getAnimations().length),
    0,
    'an archive accepted after leaving Inbox moves no row in All mail',
  )
  equal(await toast(page).count(), 0, 'an archive accepted after leaving Inbox shows no toast')
  await openInbox(page)
  await waitForTotal(page, total - 1)
}

/**
 * Leaving Inbox while an archived row slides out moves nothing in All mail. All mail mounts
 * its row for the same conversation before Inbox's row goes, and that row is not the one
 * that was leaving. The page counts every animation started on a connected row for the
 * conversation from the moment it opens All mail.
 */
async function checkLeaveDuringExit(page: Page) {
  const id = await openSharedRow(page)
  const left = page.evaluate(
    ([leaving, waitMs]) =>
      new Promise<void>((resolve, reject) => {
        const subtitle = document.querySelector('[data-field="subtitle"]')
        const row = document.querySelector(`[data-list="mail"] [data-row="${leaving}"]`)
        const allMail = [...document.querySelectorAll<HTMLElement>('nav[aria-label="Sidebar"] button')].find((button) =>
          button.textContent?.startsWith('All mail'),
        )
        if (!subtitle || !row || !allMail) throw new Error('Inbox, its row or the All mail button is missing')
        const before = subtitle.textContent
        const fail = (message: string) => {
          observer.disconnect()
          clearTimeout(timer)
          reject(new Error(message))
        }
        // Once the core has taken the row out of Inbox, while the row still slides out.
        const observer = new MutationObserver(() => {
          if (!row.isConnected && subtitle.textContent === before)
            return fail('the row finished leaving before the core took it out of Inbox, so the check missed the exit')
          if (subtitle.textContent === before || !row.isConnected) return
          observer.disconnect()
          clearTimeout(timer)
          document.body.dataset.rowAnimations = '0'
          const animate = Element.prototype.animate
          Element.prototype.animate = function (...args) {
            if (this.isConnected && this.getAttribute('data-row') === leaving)
              document.body.dataset.rowAnimations = String(Number(document.body.dataset.rowAnimations) + 1)
            return animate.apply(this, args)
          }
          allMail.click()
          resolve()
        })
        const timer = setTimeout(() => fail(`the core did not take the row out of Inbox within ${waitMs} ms`), waitMs)
        observer.observe(document.body, { childList: true, subtree: true, characterData: true })
      }),
    [id, WAIT_MS] as const,
  )
  await page.keyboard.press('e')
  await left
  await page.locator(`[data-list="mail"] [data-row="${id}"] [data-field="subject"]`).waitFor()
  await settle(page)
  equal(
    await page.evaluate(() => document.body.dataset.rowAnimations),
    '0',
    "leaving Inbox mid-exit runs no animation on All mail's row for the same conversation",
  )
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
  const move = relay.lastMove() as { remove?: string[] } | undefined
  const inbox = move?.remove?.[0]
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

/**
 * A scroll while a row leaves a windowed list ends its exit at once. The row is never
 * placed in the window the scroll moved to, which would set it among rows it never sat
 * beside and add a row past the window's size.
 */
async function checkScrollDuringExit(page: Page) {
  await openInbox(page)
  const id = await mailRows(page).nth(1).getAttribute('data-row')
  if (!id) throw new Error('Inbox shows fewer than two conversations')
  await mailRows(page).nth(1).click()
  // Once the row starts to slide, scroll ten rows down, then report whether the row is
  // still there when the list first renders the moved window (its top spacer changes).
  const placed = page.locator('[data-list="mail"]').evaluate(
    (list, leaving) =>
      new Promise<boolean>((resolve) => {
        const row = list.querySelector(`[data-row="${leaving}"]`)
        const spacer = list.firstElementChild
        if (!row || !(spacer instanceof HTMLElement)) throw new Error('Inbox has no such row')
        const scroll = () => {
          if (row.getAnimations().length === 0) return void requestAnimationFrame(scroll)
          const top = spacer.style.height
          const observer = new MutationObserver(() => {
            if (spacer.style.height === top) return
            observer.disconnect()
            resolve(list.querySelector(`[data-row="${leaving}"]`) !== null)
          })
          observer.observe(list, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] })
          list.scrollTop += 10 * 73
        }
        scroll()
      }),
    id,
  )
  await page.keyboard.press('e')
  equal(await placed, false, 'scrolling during an exit drops the leaving row from the moved window')
  await page.locator('[data-list="mail"]').evaluate((list) => list.scrollTo({ top: 0 }))
}

/** Marks every Your turn conversation done, one after another, each once the one before has gone. */
async function clearYourTurn(page: Page): Promise<void> {
  const [id] = await rowIds(page)
  if (!id) return
  await page.keyboard.press('d')
  await page.locator(`[data-row="${id}"]`).waitFor({ state: 'detached' })
  return clearYourTurn(page)
}

export async function checkDone(browser: Browser, url: string) {
  const { page, relay, errors, close } = await openPage(browser, url, 'trace-done.zip')
  await yourTurn(page).first().locator('[data-field="subject"]').waitFor()
  await checkReaderLayout(page)
  await page.setViewportSize(SIZES.wide)
  await checkDoneAndUndo(page)
  await checkLateArchive(page, relay)
  await checkLeaveDuringExit(page)
  await checkArchiveAndTrashUndo(page)
  await checkTrashFromSent(page)
  await checkUndoing(page, relay)
  await checkRefusals(page, relay)
  await checkScrollDuringExit(page)

  // Clearing Your turn leaves the empty state.
  await nav(page, 'People').click()
  await yourTurn(page).first().click()
  await clearYourTurn(page)
  const empty = page.locator('section[aria-label="Your turn"] [data-field="empty"]')
  equal(await empty.textContent(), 'Nothing waits on you', 'an empty Your turn says "Nothing waits on you"')
  equal(await count(page), '0', 'the Your turn count reads 0')

  // With reduced motion, the row goes in the same update that lowers the count.
  await page.keyboard.press('z')
  await yourTurn(page).first().waitFor()
  const [back] = await rowIds(page)
  if (!back) throw new Error('z brought nothing back to Your turn')
  await page.locator(`[data-row="${back}"][aria-selected="true"]`).waitFor()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const stillThere = rowWhenCountDrops(page, back)
  await page.keyboard.press('d')
  equal(await stillThere, false, 'reduced motion: the row is gone in the same frame the count drops')
  await empty.waitFor()
  await capture(page, 'nothing-waits')

  equal(appErrors(errors), [], 'the done states logged no errors')
  await close()
}
