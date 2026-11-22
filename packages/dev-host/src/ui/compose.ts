// The UI check of writing a new message and forwarding, over the dev host's parts in this
// process like reply.ts, so it can hold a send's window and count what the provider got.
// C or the list head's pen puts the compose page in the reader. People the core suggests open
// under To as the user types, ↑ ↓ choose and ↵ adds. Cc shows once asked for, and Bcc stays a
// link at its end. Esc puts the page away and keeps the draft, across screens and a reload.
// Send, the toast, Undo and "Undoing…" work as for a reply, and Undo brings the page back.
// compose-recovery.ts checks reloads, and forward.ts checks Forward on the same page. Screens
// are captured at 1440×900 and 1024×700, at twice their pixels, as `compose-c-*.png` and
// `forward-b-*.png`, beside the mocks of the same names (mocks/features/compose/shots).
//
// Cores started while `hold` is true keep a send's window open for as long as they run. A
// reload starts the next core.

import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { startSimProvider } from '@letterbox/sim-provider/server'
import type { Browser } from 'playwright'
import { logChildrenTo, stopChildren } from '../children.ts'
import { buildCore, type Paths } from '../core.ts'
import { startServer } from '../server.ts'
import {
  ADDED,
  captureScene,
  composePage,
  lineInput,
  lines,
  pageChips,
  pageOf,
  selectedRows,
  subjectField,
  suggested,
  suggestions,
  text,
} from './compose-page.ts'
import { checkComposeRecovery } from './compose-recovery.ts'
import { checkForward } from './forward.ts'
import { appErrors, equal, openPage, root } from './record.ts'
import { lastSend, ME, nav, open, seed, toast, undoOffered, yourTurn } from './reply-page.ts'

const STATE = join(root, '.letterbox/ui-check-compose')

const SUBJECT = 'Northfield pilot, week of the 24th'
const WRITTEN = [
  'Hi Maya,',
  'Northfield’s ops lead confirmed the week of the 24th this morning, and their CFO signed off on the pilot scope yesterday. We’re on.',
  'Jules, could you hold the Thursday of that week for the kickoff? I’ll send the agenda once Maya and I have gone through the interview plan.',
  'Robin',
].join('\n\n')

export async function checkCompose(browser: Browser) {
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
  for (const message of ADDED) mailbox.deliver(message)
  const hold = { on: true }
  const server = await startServer({
    paths,
    port: 0,
    relay: true,
    sim: { now: seed.now, deliver: () => {} },
    coreFlags: () => (hold.on ? ['--hold-waits'] : []),
  })
  const opened = await openPage(browser, server.url, 'trace-compose.zip')
  const { page, errors, relay } = opened
  try {
    // A load after `window.name` is set to this finds session storage refusing (compose-recovery.ts).
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

    // The pen sits in the list's head, and its tooltip names C.
    const pen = page.getByRole('button', { name: 'New message', exact: true })
    await pen.hover()
    equal(
      await page.getByRole('tooltip').filter({ hasText: 'New message' }).textContent(),
      'New messageC',
      "the list head's pen says New message, with its key C",
    )

    // C takes the reader with a new message, and no row shows selected meanwhile.
    // A conversation already read, so the list shows as the mock does.
    await open(page, 'Climbing on Saturday?')
    await page.keyboard.press('c')
    await pageOf(page, 'New message').waitFor()
    equal(
      [
        await composePage(page).locator('[data-field="compose-title"]').textContent(),
        await lineInput(page, 'to').evaluate((input) => input === document.activeElement),
        await selectedRows(page).count(),
        await page.locator('h3[data-field="reader-subject"]').count(),
        await pen.getAttribute('aria-pressed'),
      ],
      ['New message', true, 0, 0, 'true'],
      'C puts the new message in the reader, the cursor in To, no row shows selected, and the pen is lit',
    )
    equal(await lines(page), ['to'], 'a new message shows only To, with Cc and Bcc as links')

    // Typing in To suggests people from past mail, the typed text marked where a word starts.
    await page.keyboard.type('ma')
    await suggestions(page).waitFor()
    const offered = await suggested(page)
    equal(
      offered.map((person) => person.name),
      ['Maya Lindqvist', 'Leo Marchetti', 'Marcus Bell', 'Malik Haddad'],
      'typing "ma" suggests the people whose name or address starts a word with it, those I wrote to first',
    )
    equal(
      [offered[1]?.marked, offered[0]?.active],
      [['Ma', 'ma'], true],
      'the typed text is marked where it starts a word of the name and the address, and the first is chosen',
    )
    // The age of the newest mail with each, flush right, 16 px in from the float's edge.
    const ages = await suggestions(page).evaluate((float) =>
      [...float.querySelectorAll('[data-field="last-mail"]')].map((age) => [
        age.textContent,
        Math.round(float.getBoundingClientRect().right - age.getBoundingClientRect().right),
        getComputedStyle(age).fontVariantNumeric,
      ]),
    )
    equal(
      ages,
      [
        ['1h', 16, 'tabular-nums'],
        ['7h', 16, 'tabular-nums'],
        ['5d', 16, 'tabular-nums'],
        ['Jan 26', 16, 'tabular-nums'],
      ],
      'each suggestion ends with how long ago the newest mail with them was, in tabular figures, 16 px from the edge',
    )
    await captureScene(page, 'compose-c-suggest', () => pen.hover())
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowUp')
    equal(
      (await suggested(page)).map((person) => person.active),
      [false, true, false, false],
      '↓ and ↑ move the choice',
    )
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('Enter')
    equal(
      [await pageChips(page, 'to'), await lineInput(page, 'to').inputValue(), await suggestions(page).count()],
      [['Maya Lindqvist <maya@haldenstudio.test>'], '', 0],
      '↵ adds the chosen person to To, by name, and the suggestions go',
    )

    // Cc shows once asked for, with Bcc still a link at its end. A suggestion is clicked there.
    await composePage(page).getByRole('button', { name: 'Cc', exact: true }).click()
    equal(
      [
        await lines(page),
        await lineInput(page, 'cc').evaluate((input) => input === document.activeElement),
        await composePage(page).locator('[data-address-line="cc"]').getByRole('button', { name: 'Bcc' }).count(),
      ],
      [['to', 'cc'], true, 1],
      'Cc shows and takes the cursor, and Bcc stays a link at the end of its line, with no empty Bcc line',
    )
    await page.keyboard.type('jul')
    await suggestions(page)
      .getByRole('option', { name: /Jules Moreau/ })
      .click()
    equal(await pageChips(page, 'cc'), ['Jules Moreau <jules@moreaustudio.test>'], 'a click adds a suggestion to Cc')

    await subjectField(page).fill(SUBJECT)
    await text(page).fill(WRITTEN)
    await captureScene(page, 'compose-c-ready')

    // Esc puts the page away and brings back the conversation that was open. The draft stays.
    await page.keyboard.press('Escape')
    await page.locator('h3[data-field="reader-subject"]', { hasText: 'Climbing on Saturday?' }).waitFor()
    equal(
      [await composePage(page).count(), await selectedRows(page).count()],
      [0, 1],
      'Esc puts the page away, and the conversation it covered is open and selected again',
    )
    const kept = async () => [
      await pageChips(page, 'to'),
      await pageChips(page, 'cc'),
      await subjectField(page).inputValue(),
      await text(page).inputValue(),
    ]
    const whole = [
      ['Maya Lindqvist <maya@haldenstudio.test>'],
      ['Jules Moreau <jules@moreaustudio.test>'],
      SUBJECT,
      WRITTEN,
    ]
    await nav(page, 'All mail').click()
    await page.locator('[data-list="mail"] [role="option"]').first().waitFor()
    await page.getByRole('button', { name: 'New message', exact: true }).click()
    equal(await kept(), whole, 'on another screen, the pen brings back the same draft')
    await page.reload()
    await pageOf(page, 'New message').waitFor()
    equal(await kept(), whole, 'after a reload, the page is up with the same draft')

    // Send works as a reply's: the page goes, the toast offers Undo while the core holds it.
    await text(page).click()
    await page.keyboard.press('Control+Enter')
    await composePage(page).waitFor({ state: 'detached' })
    const sent = lastSend(relay)
    equal(
      sent && [sent.to, sent.cc, sent.bcc, sent.subject, sent.text, sent.inReplyTo, 'forwardOf' in sent],
      [['maya@haldenstudio.test'], ['jules@moreaustudio.test'], [], SUBJECT, WRITTEN, null, false],
      'Send hands the core a new message: answering nothing, forwarding nothing',
    )
    await toast(page).getByRole('button', { name: /^Undo/, disabled: false }).waitFor()
    equal(
      [await toast(page).locator('[data-field="toast"]').textContent(), await undoOffered(page)],
      ['Sending', true],
      'the toast says Sending, and offers Undo once it has found the new conversation',
    )

    // Undo, its answer held back: the toast says Undoing… until it lands, then the page is back as it was.
    const answered = relay.holdNextUndoAnswer()
    await page.keyboard.press('z')
    await answered
    equal(
      [await toast(page).locator('[data-field="toast"]').textContent(), await composePage(page).count()],
      ['Undoing…', 0],
      'while the undo waits on the core, the toast says Undoing…',
    )
    relay.releaseUndoAnswer()
    await pageOf(page, 'New message').waitFor()
    equal(await kept(), whole, 'Undo puts the new message back on the page, exactly as it was')
    equal([mailbox.calls().send, await toast(page).count()], [0, 0], 'the provider got nothing, and the toast went')

    // Discard throws it away, and C starts a blank one.
    await composePage(page).getByRole('button', { name: 'Discard' }).click()
    await composePage(page).waitFor({ state: 'detached' })
    await page.keyboard.press('c')
    equal(
      [await pageChips(page, 'to'), await subjectField(page).inputValue(), await text(page).inputValue()],
      [[], '', ''],
      'after Discard, C starts a blank message',
    )
    await page.keyboard.press('Escape')

    await checkComposeRecovery(page, relay, mailbox)
    await checkForward(page, relay, mailbox, hold)
    // compose-recovery.ts drops the connection on purpose, and the page reports each loss.
    equal(appErrors(errors, { lostCore: true }), [], 'the compose run logged no page errors')
  } finally {
    await opened.close()
    await server.close()
    await provider.close()
    await stopChildren()
  }
}
