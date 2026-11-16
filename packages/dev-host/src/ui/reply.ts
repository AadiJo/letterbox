// The UI check of replying, over the dev host's parts in this process, like rollback.ts, so it
// can tell the sim provider to refuse or hold a send and count the sends it got. R opens the
// docked editor with To filled in, Shift+R adds Cc without the user, Esc keeps the draft, and
// each conversation keeps its own. A bad address stops at its line. Send shows the reply at
// once, hands the turn over and offers Undo for exactly as long as the core holds it: page
// time, another screen or a reload do not end it, the core's update does. Undo over a newer
// draft keeps both texts. Past the window the reply goes exactly once. A refused send says why
// and can be written again, and a send whose answer is lost waits as Checking, then goes once.
//
// The dev host's clock is fixed and its waits end at once, so a send's window passes as soon
// as it starts. Cores started while `hold` is true get `--hold-waits`, which keeps the window
// open for as long as that core runs. A reload starts the next core. The check controls time
// only through the core: the page's own clock it takes over, and moves only to show it does nothing.

import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { devSeeds } from '@letterbox/sim-provider/seeds'
import { startSimProvider } from '@letterbox/sim-provider/server'
import type { Browser, Page } from 'playwright'
import { logChildrenTo, stopChildren } from '../children.ts'
import { buildCore, type Paths } from '../core.ts'
import { startServer } from '../server.ts'
import { appErrors, capture, equal, openPage, root } from './record.ts'

const seed = devSeeds['people-first']
const STATE = join(root, '.letterbox/ui-check-reply')
const ME = seed.seed.address
/** A newer draft written while a reply is still in its undo window. */
const SECOND = 'Second thought: the venue is booked already.'

/** A message to the user and one more person, copying a third, for Reply all. */
const GROUP = {
  key: 'group-1',
  mailboxes: ['inbox'],
  from: { name: 'Maya Lindqvist', address: 'maya@lindqvist.example' },
  to: [
    { name: 'Robin Vale', address: ME },
    { name: 'Tomas Okafor', address: 'tomas.okafor@fernway.example' },
  ],
  cc: [{ name: 'Priya Raman', address: 'priya@ramanstudio.example' }],
  subject: 'Picnic on Sunday',
  text: 'Hi all, can each of you bring something on Sunday?',
  sentAt: new Date(Date.parse(seed.now) - 10 * 60_000).toISOString(),
}

const dock = (page: Page) => page.locator('section[aria-label="Reply"]')
const bar = (page: Page) => page.locator('[data-field="reply-bar"]')
const body = (page: Page) => dock(page).getByRole('textbox', { name: 'Message' })
const toast = (page: Page) => page.getByRole('status').filter({ has: page.locator('[data-field="toast"]') })
const reason = (page: Page) => page.locator('[data-field="reason"]').textContent()
const row = (page: Page, subject: string) =>
  page.locator('[role="option"]').filter({ has: page.locator('[data-field="subject"]', { hasText: subject }) })
/** Whether the toast offers Undo right now. */
const undoOffered = async (page: Page) => (await toast(page).getByRole('button', { name: /^Undo/ }).count()) === 1
const yourTurn = (page: Page) => page.locator('[role="listbox"][aria-label="Your turn"] [role="option"]')
const nav = (page: Page, name: string) =>
  page.getByRole('navigation', { name: 'Sidebar' }).getByRole('button', { name: new RegExp(`^${name}`) })

/** The people on one address line of the open editor, as each chip's tooltip names them. */
const chips = (page: Page, line: 'to' | 'cc') =>
  dock(page)
    .locator(`[data-address-line="${line}"] [data-chip]`)
    .evaluateAll((found) => found.map((chip) => chip.getAttribute('title')))

/** Opens the conversation `subject` from the list on screen and waits for its newest message. */
async function open(page: Page, subject: string) {
  await row(page, subject).first().click()
  await page.locator('h3[data-field="reader-subject"]', { hasText: subject }).waitFor()
  await page.locator('[data-message="open"]').last().waitFor()
}

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
  const server = await startServer({
    paths,
    port: 0,
    relay: true,
    sim: { now: seed.now, deliver: () => mailbox.deliver(GROUP) },
    coreFlags: () => (hold ? ['--hold-waits'] : []),
  })
  const opened = await openPage(browser, server.url, 'trace-reply.zip')
  const { page, errors, relay } = opened
  try {
    await page.waitForFunction(() => window.letterboxDev !== undefined)
    await page.evaluate(([address, password]) => window.letterboxDev?.signIn(address, password), [
      ME,
      seed.seed.password,
    ] as const)
    await yourTurn(page).first().waitFor()

    // R opens the dock on the open conversation, to the person who wrote last, and the cursor is in the body.
    await open(page, 'Notes from Thursday')
    await page.keyboard.press('r')
    await dock(page).waitFor()
    equal(await chips(page, 'to'), ['Maya Lindqvist <maya@lindqvist.example>'], 'R fills To with the last sender')
    equal(await dock(page).locator('[data-address-line="cc"]').count(), 0, 'Reply has no Cc line to show')
    equal(await body(page).evaluate((element) => element === document.activeElement), true, 'the body has focus')
    const share = await page.evaluate(() => {
      const reply = document.querySelector('section[aria-label="Reply"]')
      const pane = reply?.closest('article')
      return reply && pane ? reply.getBoundingClientRect().height / pane.getBoundingClientRect().height : 0
    })
    equal(share > 0.35 && share < 0.45, true, `the dock takes about 40% of the reader (${Math.round(share * 100)}%)`)
    const mayaText =
      "Hi Maya,\n\nThe 22nd works for me, let's put that in the summary. You're right about the cover, it was counted twice, so the total drops by 140.\n\nPlease take the venue. I hadn't started anything there.\n\nRobin"
    await body(page).fill(mayaText)
    await capture(page, 'reply-dock')

    // Esc folds it to a bar and keeps the draft.
    await page.keyboard.press('Escape')
    await bar(page).waitFor()
    equal(await dock(page).count(), 0, 'Esc closes the editor')
    equal((await bar(page).textContent())?.startsWith('Reply to MayaHi Maya'), true, 'the bar keeps the draft')

    // Another conversation keeps a draft of its own.
    await open(page, 'Can you sign the lease addendum?')
    equal(await bar(page).count(), 0, 'a conversation with no draft shows no bar')
    await page.keyboard.press('r')
    await body(page).fill('Signed, sending it back today.')
    await open(page, 'Notes from Thursday')
    await bar(page).click()
    equal(await body(page).inputValue(), mayaText, "Maya's draft is still Maya's")
    await open(page, 'Can you sign the lease addendum?')
    equal(await body(page).inputValue(), 'Signed, sending it back today.', "Tomas's draft is still Tomas's")
    await dock(page).getByRole('button', { name: 'Discard' }).click()
    equal([await dock(page).count(), await bar(page).count()], [0, 0], 'Discard throws the draft away')

    // Shift+R copies everyone else on the message, never the user.
    await page.evaluate(() => window.letterboxDev?.deliver(1))
    await nav(page, 'All mail').click()
    await open(page, 'Picnic on Sunday')
    await page.keyboard.press('Shift+R')
    await dock(page).waitFor()
    equal(await chips(page, 'to'), ['Maya Lindqvist <maya@lindqvist.example>'], 'Reply all sends to the sender')
    equal(
      await chips(page, 'cc'),
      ['Tomas Okafor <tomas.okafor@fernway.example>', 'Priya Raman <priya@ramanstudio.example>'],
      'Reply all copies the others, and not me',
    )

    // An address the core would refuse stops at its line, and nothing is sent.
    await dock(page).locator('input[data-line="to"]').fill('ben@exämple.com')
    await dock(page).locator('input[data-line="to"]').press('Enter')
    await body(page).fill('Count me in.')
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

    // Undo ends when the core says, not with the screen: it stays on All mail.
    await nav(page, 'All mail').click()
    await page.locator('[data-list="mail"] [role="option"]').first().waitFor()
    equal(await undoOffered(page), true, 'Undo stays offered on another screen')
    await nav(page, 'People').click()

    // A new draft can start in the window. Undo puts the reply back in front of it, and neither is lost.
    await open(page, 'Notes from Thursday')
    await page.keyboard.press('r')
    await body(page).fill(SECOND)
    await toast(page).getByRole('button', { name: /^Undo/ }).click()
    await held.waitFor({ state: 'detached' })
    equal(
      await body(page).inputValue(),
      `${mayaText}\n\n${SECOND}`,
      'Undo puts the reply back first, then the newer draft',
    )
    equal((await reason(page))?.startsWith('Your turn'), true, 'and the turn is mine again')
    equal([mailbox.calls().send, await toast(page).count()], [0, 0], 'the provider got no send, and the toast went')

    // Sent again, for the picture.
    await body(page).fill(mayaText)
    await page.keyboard.press('Control+Enter')
    await held.waitFor()
    await capture(page, 'reply-sending')

    // A reload starts another core, which still holds it. Undo is offered again, with nothing opened.
    await page.reload()
    await toast(page).getByRole('button', { name: /^Undo/ }).waitFor()
    equal(await undoOffered(page), true, 'after a reload the held reply offers Undo again')

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
    const delivered = page.locator('[data-message="open"][data-delivery="delivered"]', { hasText: 'The 22nd works' })
    await delivered.waitFor()
    equal(await page.locator('[data-field="delivery"]').count(), 0, 'past its window the reply looks like any other')
    equal([mailbox.calls().send, mailbox.sent().length], [1, 1], 'the provider got it exactly once')

    // A send the provider refuses says so on the message, and can be written again.
    mailbox.refuseNextSend('refused-by-provider')
    await open(page, 'Draft cover for the zine')
    await page.keyboard.press('r')
    await body(page).fill('Here is the cover with the new title.')
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
      [await body(page).inputValue(), await chips(page, 'to')],
      ['Here is the cover with the new title.', ['Priya Raman <priya@ramanstudio.example>']],
      'Edit and send again opens its text, to the same person',
    )
    equal(mailbox.sent().length, 1, 'the refused reply left nothing at the provider')
    await dock(page).getByRole('button', { name: 'Discard' }).click()

    // The core's answer to a send is lost on the way. The core may have it, so the reply
    // waits as Checking and cannot be sent twice. The next connection sends the same change,
    // which the core answers from what it already has.
    await open(page, 'Climbing on Saturday?')
    await page.keyboard.press('r')
    await body(page).fill('Yes, count me in for Saturday.')
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
