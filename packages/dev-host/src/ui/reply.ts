// The UI check of replying, over the dev host's parts in this process, like rollback.ts, so it
// can tell the sim provider to refuse or hold a send and count the sends it got. R opens the
// docked editor with To filled in, Shift+R adds Cc without the user, Esc keeps the draft, and
// each conversation keeps its own. A bad address stops at its line. Send shows the reply at
// once, hands the turn over and offers Undo for exactly as long as the core holds it: page
// time, another screen or a reload do not end it, the core's update does. Meanwhile R shows
// that reply read only and starts no second one, and Undo brings back exactly that reply,
// even after someone else wrote. Past the window the reply goes exactly once. A refused send says why
// and can be written again, and a send whose answer is lost waits as Checking, then goes once.
// reply-recovery.ts adds a reload without session storage and a merge of conversations, and
// reply-page.ts holds the mail and page helpers both share.
//
// The dev host's clock is fixed and its waits end at once, so a send's window passes as soon
// as it starts. Cores started while `hold` is true get `--hold-waits`, which keeps the window
// open for as long as that core runs. A reload starts the next core. The check controls time
// only through the core: the page's own clock it takes over, and moves only to show it does nothing.

import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { startSimProvider } from '@letterbox/sim-provider/server'
import type { Browser } from 'playwright'
import { logChildrenTo, stopChildren } from '../children.ts'
import { buildCore, type Paths } from '../core.ts'
import { startServer } from '../server.ts'
import { checkDockEdges, checkDockFits, checkDraftFidelity, checkDraftReadsLikeBody, draftText, write } from './dock.ts'
import { appErrors, capture, captureC2, equal, openPage, root } from './record.ts'
import {
  bar,
  body,
  BREAD,
  CC_ONLY,
  chips,
  dock,
  GROUP,
  lastSend,
  ME,
  nav,
  open,
  reason,
  seed,
  toast,
  TOMAS,
  TRIP_LINK,
  TRIPS,
  replyAll,
  undoOffered,
  yourTurn,
} from './reply-page.ts'
import { checkBccAfterReload, checkMergedConversation } from './reply-recovery.ts'

const STATE = join(root, '.letterbox/ui-check-reply')
export async function checkReply(browser: Browser) {
  rmSync(STATE, { recursive: true, force: true })
  const paths: Paths = {
    root,
    data: join(STATE, 'data'),
    socket: join(STATE, 'provider.sock'),
    coreLog: join(STATE, 'core.log'),
  }
  mkdirSync(paths.data, { recursive: true })
  logChildrenTo(join(STATE, 'host.log'))

  await buildCore(paths)
  const provider = await startSimProvider(paths.socket)
  const mailbox = provider.createMailbox(seed.dialect, seed.seed)
  let hold = true
  /** What each `letterboxDev.deliver` call brings, in order. */
  const toDeliver = [[GROUP, CC_ONLY], [TOMAS], TRIPS, [TRIP_LINK]]
  const server = await startServer({
    paths,
    port: 0,
    relay: true,
    sim: {
      now: seed.now,
      deliver: (count) =>
        toDeliver
          .splice(0, count)
          .flat()
          .forEach((message) => mailbox.deliver(message)),
    },
    coreFlags: () => (hold ? ['--hold-waits'] : []),
  })
  const opened = await openPage(browser, server.url, 'trace-reply.zip')
  const { page, errors, relay } = opened
  try {
    // A load after `window.name` is set to this finds session storage refusing, as in a locked-down browser.
    await page.addInitScript(() => {
      if (window.name !== 'no-session-storage') return
      Object.defineProperty(window, 'sessionStorage', {
        get: () => {
          throw new DOMException('The UI check turned session storage off.', 'SecurityError')
        },
      })
    })
    await page.waitForFunction(() => window.letterboxDev !== undefined)
    await page.evaluate(([address, password]) => window.letterboxDev?.signIn(address, password), [
      ME,
      seed.seed.password,
    ] as const)
    await yourTurn(page).first().waitFor()

    // Maya wrote to the user alone, so the bar offers Reply and no Reply all.
    await open(page, 'Notes from Thursday')
    equal(await replyAll(page).count(), 0, 'a message to the user alone offers no Reply all')

    // R opens the dock on the open conversation, to the person who wrote last, and the cursor is in the body.
    await page.keyboard.press('r')
    await dock(page).waitFor()
    equal(await chips(page, 'to'), ['Maya Lindqvist <maya@haldenstudio.test>'], 'R fills To with the last sender')
    await checkDockEdges(page)
    equal(await dock(page).locator('[data-address-line="cc"]').count(), 0, 'Reply has no Cc line to show')
    equal(await body(page).evaluate((element) => element === document.activeElement), true, 'the body has focus')
    equal(
      await page.locator('[class*="lucide-paperclip"], [data-field="attach"]').count(),
      0,
      'the editor has no attachment control',
    )
    /** The dock's share of the reader, and the editor's height, as the text grows. */
    const sizes = () =>
      page.evaluate(() => {
        const reply = document.querySelector('section[aria-label="Reply"]')
        const pane = reply?.closest('article')
        const editor = reply?.querySelector('[data-field="draft"]')
        if (!reply || !pane || !editor) throw new Error('the reply editor is not in the reader')
        return {
          share: reply.getBoundingClientRect().height / pane.getBoundingClientRect().height,
          editor: editor.getBoundingClientRect().height,
        }
      })
    const empty = await sizes()
    equal(Math.round(empty.editor), 120, 'an empty editor is 120 px tall')
    const mayaText =
      'Hi Maya,\n\nNorthfield confirmed the week of the 24th this morning. I’ll forward you their note so you have it in writing.\n\n12 interviews is fine. Let’s keep the budget where it is and revisit after the first six.'
    await write(page, mayaText)
    const written = await sizes()
    equal(written.editor > empty.editor, true, `the editor grows with its text (${Math.round(written.editor)} px)`)
    equal(await draftText(page), mayaText, 'the draft holds what was typed, a blank line between paragraphs')

    await checkDraftReadsLikeBody(page)

    await write(page, `${mayaText}\n\n${'More to say.\n'.repeat(40).trimEnd()}`)
    const long = await sizes()
    equal(long.share <= 0.401, true, `a long reply stops at 40% of the reader (${Math.round(long.share * 100)}%)`)
    await write(page, mayaText)
    await captureC2(page, 'reply-1440')
    await capture(page, 'reply-dock')

    // Esc folds it to a bar and keeps the draft.
    await page.keyboard.press('Escape')
    await bar(page).waitFor()
    equal(await dock(page).count(), 0, 'Esc closes the editor')
    equal((await bar(page).textContent())?.startsWith('Reply to MayaHi Maya'), true, 'the bar keeps the draft')

    // Another conversation keeps a draft of its own.
    await open(page, 'Lease addendum for 4B')
    equal(await bar(page).textContent(), 'Reply to TomasR', 'a conversation with no draft offers an empty reply')
    await page.keyboard.press('r')
    await write(page, 'Signed, sending it back today.')
    await open(page, 'Notes from Thursday')
    await bar(page).click()
    equal(await draftText(page), mayaText, "Maya's draft is still Maya's")
    await open(page, 'Lease addendum for 4B')
    equal(await draftText(page), 'Signed, sending it back today.', "Tomas's draft is still Tomas's")
    await dock(page).getByRole('button', { name: 'Discard' }).click()
    equal(
      [await dock(page).count(), await bar(page).textContent()],
      [0, 'Reply to TomasR'],
      'Discard throws the draft away',
    )

    // Drafts come back exactly as written: through Minimize, a trip away, and Send then Undo.
    await checkDraftFidelity(page, 'Lease addendum for 4B', 'Notes from Thursday')

    // Shift+R copies everyone else on the message, never the user.
    await page.evaluate(() => window.letterboxDev?.deliver(1))
    await nav(page, 'All mail').click()
    await open(page, 'Picnic on Sunday')
    equal(await replyAll(page).count(), 1, 'a message to others too offers Reply all')
    await page.keyboard.press('Shift+R')
    await dock(page).waitFor()
    equal(await chips(page, 'to'), ['Maya Lindqvist <maya@haldenstudio.test>'], 'Reply all sends to the sender')
    equal(
      await chips(page, 'cc'),
      ['Tomas Okafor <tomas.okafor@fernmail.test>', 'Priya Raman <priya@ramanpress.test>'],
      'Reply all copies the others, and not me',
    )

    await checkDockFits(page)

    // An address the core would refuse stops at its line, and nothing is sent.
    await dock(page).locator('input[data-line="to"]').fill('ben@exämple.com')
    await dock(page).locator('input[data-line="to"]').press('Enter')
    await write(page, 'Count me in.')
    await page.keyboard.press('Control+Enter')
    const problem = dock(page).locator('[data-address-line="to"] [data-field="address-problem"]')
    await problem.waitFor()
    equal(
      await problem.textContent(),
      '"ben@exämple.com" is not an address Letterbox can send to. Use a plain address, like name@example.com.',
      'an address that is not plain ASCII is refused on the To line',
    )
    equal(await dock(page).locator('[data-chip="invalid"]').count(), 1, 'its chip is marked')
    equal(
      [mailbox.calls().send, await page.locator('[data-delivery="held"]').count()],
      [0, 0],
      'nothing reached the provider or the thread',
    )
    await dock(page).getByRole('button', { name: 'Discard' }).click()

    // The user's own message, only to Cc, can still be answered: the bar offers Reply all.
    await nav(page, 'All mail').click()
    await open(page, 'Studio party list')
    equal(
      [await bar(page).textContent(), await replyAll(page).count()],
      ['ReplyR', 1],
      "the user's own message sent only to Cc still offers a reply, and Reply all",
    )

    // Send: the reply is in the thread at once, the turn moves, and the toast offers Undo.
    await nav(page, 'People').click()
    await open(page, 'Notes from Thursday')
    const mine = await yourTurn(page).count()
    // Maya's editor was left open when the check moved on, so it is open here again.
    await body(page).click()
    // The page's clock is the check's from here, so it can show that page time ends nothing.
    await page.clock.install()
    await page.keyboard.press('Control+Enter')
    const held = page.locator('[data-message="open"][data-delivery="held"]')
    await held.waitFor()
    equal(await dock(page).count(), 0, 'Send closes the editor')
    equal(
      /^Sending in \d+ s$/.test((await held.locator('[data-field="delivery"]').textContent()) ?? ''),
      true,
      'the reply is marked Sending, with the seconds the core gave it',
    )
    equal(await toast(page).locator('[data-field="toast"]').textContent(), 'Sending', 'the toast says Sending')
    await page.waitForFunction(
      (count) => document.querySelectorAll('[aria-label="Your turn"] [role="option"]').length === count,
      mine - 1,
    )
    equal((await reason(page))?.startsWith('Waiting on them'), true, 'the conversation waits on Maya now')

    // Page time decides nothing. A minute of it passes, the core still holds the reply, and Undo stays.
    await page.clock.fastForward('01:00')
    equal(await undoOffered(page), true, 'a minute of page time later the core still holds it, and Undo stays')
    // Time flows again from here. Playwright's own waits poll on the page's clock.
    await page.clock.resume()

    // Undo ends when the core says, not with the screen: it stays on All mail.
    await nav(page, 'All mail').click()
    await page.locator('[data-list="mail"] [role="option"]').first().waitFor()
    equal(await undoOffered(page), true, 'Undo stays offered on another screen')
    await nav(page, 'People').click()

    // While the core holds the reply, R starts no second one. The dock shows the held reply,
    // read only, with Undo.
    await open(page, 'Notes from Thursday')
    await page.keyboard.press('r')
    await dock(page).waitFor()
    const pendingNote = dock(page).locator('[data-field="reply-pending"]')
    const readOnly = async () => [
      /^Your reply sends in \d+ s · Undo to edit it$/.test(
        (await pendingNote.count()) === 1 ? ((await pendingNote.textContent()) ?? '') : '',
      ),
      await body(page).isEditable(),
      await dock(page).getByRole('button', { name: /^Send/ }).count(),
    ]
    equal(
      await readOnly(),
      [true, false, 0],
      'R in the window shows the held reply read only, and starts no second draft',
    )
    // Once the toast has finished rising.
    await toast(page).evaluate((element) =>
      Promise.allSettled(element.getAnimations().map((animation) => animation.finished)),
    )
    const [toastBox, dockBox] = [await toast(page).boundingBox(), await dock(page).boundingBox()]
    if (!toastBox || !dockBox) throw new Error('the toast or the dock is not on screen')
    equal(
      Math.round(dockBox.y - (toastBox.y + toastBox.height)),
      12,
      'the toast sits 12 px above the dock, clear of its Undo',
    )
    await capture(page, 'reply-pending')

    // Undo, with its answer held back. R still starts nothing, so one reply is all that can come back.
    const undoing = relay.pauseAtAccepted()
    await dock(page).getByRole('button', { name: /^Undo/ }).click()
    await undoing
    await page.keyboard.press('r')
    equal(await readOnly(), [true, false, 0], 'R while the undo is on its way still starts nothing')
    relay.resume()
    await held.waitFor({ state: 'detached' })
    await pendingNote.waitFor({ state: 'detached' })
    equal(
      [await draftText(page), await body(page).isEditable()],
      [mayaText, true],
      'Undo puts back that reply, ready to edit',
    )
    equal((await reason(page))?.startsWith('Your turn'), true, 'and the turn is mine again')
    equal([mailbox.calls().send, await toast(page).count()], [0, 0], 'the provider got no send, and the toast went')

    // Someone else writes while a reply waits, and R is pressed. Undo brings back exactly the
    // reply it cancels: its people, its text, and the message it answers.
    await open(page, 'Picnic on Sunday')
    await page.keyboard.press('Shift+R')
    await write(page, BREAD)
    await page.keyboard.press('Control+Enter')
    const heldBread = page.locator('[data-message="open"][data-delivery="held"]', { hasText: BREAD })
    await heldBread.waitFor()
    const canceled = lastSend(relay)
    await page.evaluate(() => window.letterboxDev?.deliver(1))
    // Older than the held reply, so it shows folded, with its text as the preview.
    await page.locator('[data-message]', { hasText: TOMAS.text }).waitFor()
    await page.keyboard.press('r')
    await dock(page).waitFor()
    await toast(page).getByRole('button', { name: /^Undo/ }).click()
    await heldBread.waitFor({ state: 'detached' })
    await pendingNote.waitFor({ state: 'detached' })
    equal(
      [await chips(page, 'to'), await chips(page, 'cc'), await draftText(page)],
      [
        ['Maya Lindqvist <maya@haldenstudio.test>'],
        ['Tomas Okafor <tomas.okafor@fernmail.test>', 'Priya Raman <priya@ramanpress.test>'],
        BREAD,
      ],
      "Undo brings back that reply's people and text, not a reply to Tomas",
    )
    await page.keyboard.press('Control+Enter')
    await heldBread.waitFor()
    equal(lastSend(relay), canceled, 'sent again, it is the same draft, answering the same message')
    // Taken back once more and thrown away, so the provider never gets it.
    await page.keyboard.press('z')
    await dock(page).getByRole('button', { name: 'Discard' }).click()
    await heldBread.waitFor({ state: 'detached' })

    await open(page, 'Notes from Thursday')
    await dock(page).waitFor()
    // Sent again, for the picture.
    await write(page, mayaText)
    await page.keyboard.press('Control+Enter')
    await held.waitFor()
    await capture(page, 'reply-sending')

    // A reload starts another core, which still holds it. Undo is offered again, with nothing opened.
    await page.reload()
    await toast(page).getByRole('button', { name: /^Undo/ }).waitFor()
    equal(await undoOffered(page), true, 'after a reload the held reply offers Undo again')

    await checkBccAfterReload(page)
    await checkMergedConversation(page, relay)

    // A core that lets the window pass. The provider's send call waits, so the reply shows
    // going, and the core's update that says so is what takes Undo away.
    hold = false
    mailbox.holdSends()
    await page.reload()
    await mailbox.sendHeld()
    await page.locator('[role="listbox"][aria-label="Waiting on others"] [role="option"]').first().waitFor()
    await open(page, 'Notes from Thursday')
    await page.locator('[data-message="open"][data-delivery="sending"]').waitFor()
    equal(await toast(page).count(), 0, 'once the core shows it going, nothing offers Undo')
    mailbox.releaseSends()
    const delivered = page.locator('[data-message="open"][data-delivery="delivered"]', {
      hasText: 'Northfield confirmed',
    })
    await delivered.waitFor()
    equal(await page.locator('[data-field="delivery"]').count(), 0, 'past its window the reply looks like any other')
    equal([mailbox.calls().send, mailbox.sent().length], [1, 1], 'the provider got it exactly once')
    await page.keyboard.press('r')
    await dock(page).waitFor()
    equal(
      [await body(page).isEditable(), await pendingNote.count()],
      [true, 0],
      'once the core has sent it, R starts a new reply',
    )
    await dock(page).getByRole('button', { name: 'Discard' }).click()

    // A send the provider refuses says so on the message, and can be written again.
    mailbox.refuseNextSend('refused-by-provider')
    await open(page, 'Cover draft for issue 12')
    await page.keyboard.press('r')
    await write(page, 'Here is the cover with the new title.')
    await page.keyboard.press('Control+Enter')
    const notSent = page.locator('[data-field="not-sent"]')
    await notSent.waitFor()
    equal(
      await notSent.locator('p').textContent(),
      'Not sent. The mail server refused it.',
      'a refused reply says Not sent, and why',
    )
    await capture(page, 'reply-not-sent')
    await notSent.getByRole('button', { name: 'Edit and send again' }).click()
    await dock(page).waitFor()
    equal(
      [await draftText(page), await chips(page, 'to')],
      ['Here is the cover with the new title.', ['Priya Raman <priya@ramanpress.test>']],
      'Edit and send again opens its text, to the same person',
    )
    equal(mailbox.sent().length, 1, 'the refused reply left nothing at the provider')
    await dock(page).getByRole('button', { name: 'Discard' }).click()

    // The core's answer to a send is lost on the way. The core may have it, so the reply
    // waits as Checking and cannot be sent twice. The next connection sends the same change,
    // which the core answers from what it already has.
    await open(page, 'Climbing on Saturday?')
    await page.keyboard.press('r')
    await write(page, 'Yes, count me in for Saturday.')
    const paused = relay.pauseAtAccepted()
    await page.keyboard.press('Control+Enter')
    await paused
    await relay.drop()
    const checking = dock(page).locator('[data-field="send-checking"]')
    await checking.waitFor()
    equal(
      [await checking.textContent(), await dock(page).getByRole('button', { name: /^Send/ }).isDisabled()],
      ['Checking whether this was sent…', true],
      'a lost answer shows Checking, with Send off',
    )
    await page.reload()
    await page.locator('[role="listbox"][aria-label="Waiting on others"] [role="option"]').first().waitFor()
    await open(page, 'Climbing on Saturday?')
    await page.locator('[data-message="open"][data-delivery="delivered"]', { hasText: 'count me in' }).waitFor()
    equal(await dock(page).count(), 0, 'the core had it, so the draft is settled')
    equal(
      [mailbox.sent().length, await page.locator('[data-message="open"]', { hasText: 'count me in' }).count()],
      [2, 1],
      'the reply whose answer was lost reached the provider once, and shows once',
    )
    equal(appErrors(errors), [], 'the page logged no errors')
  } finally {
    await opened.close()
    await server.close()
    await provider.close()
    await stopChildren()
  }
}
