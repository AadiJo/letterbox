// The notify run of the Electron check (electron-check.ts): new mail reaches the app's core
// through a sync, with main's notification API and badge stubbed inside main, so nothing
// reaches the desktop. It checks that mail from a machine stays quiet, that a person's mail
// that is the user's turn shows one notification with the sender and subject only, that a
// newer one in the same conversation replaces it, that the badge counts conversations and
// drops one once read, and that choosing a notification brings the window forward and opens
// the conversation in the reader, even after it timed out and the window closed, as on macOS.
// A conversation gone by then opens to the reader saying so.
//
// Each OS takes the notification differently, and the check follows notify.ts on each. Linux
// gets the subject escaped, since its notification server reads markup in the body. macOS gets
// it as is. Windows shows the toast XML that main writes. The check parses that XML in the page,
// as Windows would, chooses a toast by handing its launch value to the callback main gave
// `Notification.handleActivation`, and reads the badge from the taskbar overlay.

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SeedMessage } from '@letterbox/sim-provider/contract'
import type { Page } from 'playwright'
import { checkQuit, corePids, equal, quit, seed, STATE, untilLogged, WAIT_MS, withApp, within } from './electron-app.ts'
import type { DevServer } from './server.ts'
import type { RunningSim } from './sim.ts'

/** What the stubs in main were asked, kept on main's globalThis with the notifications made. */
type Stubs = {
  shown: { id: string; title: string; body: string }[]
  /** Each notification's toast XML, in the order shown. Empty strings off Windows. */
  toasts: string[]
  /** The title of each notification closed, as a newer one replaces it. */
  closed: string[]
  badges: number[]
  /** Every notification shown, so the check can choose one. */
  made: Electron.Notification[]
  /** Called after each badge change, so the check can wait for a count. */
  onBadge: (() => void)[]
}

declare global {
  var letterboxNotifyStubs: Stubs | undefined
  /** The callback main gave `Notification.handleActivation`, kept by ACTIVATION. Windows only. */
  var letterboxActivate: ((details: Electron.ActivationArguments) => void) | undefined
}

const windows = process.platform === 'win32'

/**
 * Preloaded into main before the app (Electron's `-r`). Main gives its activation callback at
 * start, before the check can reach it, so this keeps it on globalThis and still registers it.
 */
const ACTIVATION = `const { Notification } = require('electron')
const handle = Notification.handleActivation
Notification.handleActivation = (callback) => {
  globalThis.letterboxActivate = callback
  handle?.call(Notification, callback)
}
`

/** A toast as Windows reads it: its launch value and its lines of text. */
type Toast = { launch: string | null; lines: (string | null)[] } | 'does not parse'

/** The toast main should make for a conversation: the launch value names it, then sender and subject. */
const toastFor = (thread: string | undefined, title: string, subject: string): Toast => ({
  launch: `thread=${thread ?? ''}`,
  lines: [title, subject],
})

/** Parses toast XML in `page`, whose DOMParser holds to the XML rules. */
const toastsOf = (page: Page, xmls: string[]) =>
  page.evaluate(
    (all) =>
      all.map((text): Toast => {
        const parsed = new DOMParser().parseFromString(text, 'application/xml')
        if (parsed.querySelector('parsererror')) return 'does not parse'
        const lines = [...parsed.querySelectorAll('text')].map((line) => line.textContent)
        return { launch: parsed.documentElement.getAttribute('launch'), lines }
      }),
    xmls,
  )

// An ampersand in the name: unescaped, it would break the toast XML.
const ANA = { name: 'Ana & Check', address: 'ana@notify.example' }
const BEN = { name: 'Ben Check', address: 'ben@notify.example' }
const BEN_SUBJECT = 'Quick question'
const LUNCH = 'Lunch <next> week & more?'

/** A message to the seed's owner, from `from`, delivered now. */
const mail = (
  key: string,
  from: SeedMessage['from'],
  subject: string,
  more: Partial<SeedMessage> = {},
): SeedMessage => ({
  key,
  mailboxes: ['inbox'],
  from,
  to: [seed.seed.address],
  subject,
  text: `${subject} Let me know.`,
  sentAt: seed.now,
  ...more,
})

/** The time `seconds` after the seed's now, for mail newer than everything before it. */
const later = (seconds: number) => new Date(Date.parse(seed.now) + seconds * 1000).toISOString()

/**
 * The sidebar entry that is current, by its first words. Read by CSS, not by role: in a window
 * under 1100 px wide the sidebar is folded away, and a role query skips what is hidden.
 */
const placeOf = async (page: Page) => {
  const text = await page.locator('nav[aria-label="Sidebar"] [aria-current="page"]').textContent()
  return ['People', 'All mail'].find((name) => text?.startsWith(name)) ?? text
}

/** Waits for the reader to show `subject`, then says where: the current sidebar entry, and the chosen row. */
async function opensIn(page: Page, subject: string) {
  await page.locator('h3[data-field="reader-subject"]', { hasText: subject }).waitFor({ timeout: WAIT_MS })
  return {
    place: await placeOf(page),
    chosen: await page.locator('[role="option"][aria-selected="true"]').getAttribute('data-row'),
  }
}

export const notifyRun = async (sim: RunningSim, server: DevServer) => {
  const activation = join(STATE, 'notify-activation.cjs')
  writeFileSync(activation, ACTIVATION)
  return withApp(
    'notify',
    server.url,
    async (run) => {
      const { app, page } = run
      await app.evaluate(({ app: electron, BrowserWindow, Notification }) => {
        const stubs: Stubs = { shown: [], closed: [], toasts: [], badges: [], made: [], onBadge: [] }
        globalThis.letterboxNotifyStubs = stubs
        Notification.isSupported = () => true
        Notification.prototype.show = function show(this: Electron.Notification) {
          stubs.shown.push({ id: this.id, title: this.title, body: this.body })
          stubs.toasts.push(this.toastXml)
          stubs.made.push(this)
        }
        Notification.prototype.close = function close(this: Electron.Notification) {
          stubs.closed.push(this.title)
        }
        const badge = (count: number) => {
          stubs.badges.push(count)
          for (const told of stubs.onBadge) told()
        }
        electron.setBadgeCount = (count?: number) => {
          badge(count ?? 0)
          return true
        }
        // Windows: a dot over the taskbar button, whose description starts with the count.
        BrowserWindow.prototype.setOverlayIcon = function setOverlayIcon(
          this: Electron.BrowserWindow,
          overlay: Electron.NativeImage | null,
          description: string,
        ) {
          badge(overlay === null && description === '' ? 0 : Number.parseInt(description, 10))
        }
      })
      if (windows)
        equal(
          await app.evaluate(() => typeof globalThis.letterboxActivate),
          'function',
          'notify: on Windows main takes notification clicks through Notification.handleActivation',
        )
      /** On Windows, the toasts shown so far, parsed while a window is open, so they can be chosen after it closes. */
      let parsed: Toast[] = []
      /** Chooses notification `at`: on Windows, as the OS hands main its toast's launch value; elsewhere, its click. */
      const choose = (at: number) => {
        const toast = parsed[at]
        return app.evaluate(
          (_electron, { index, launch }) => {
            if (launch === null) return void globalThis.letterboxNotifyStubs?.made[index]?.emit('click')
            globalThis.letterboxActivate?.({ type: 'click', arguments: launch })
          },
          { index: at, launch: typeof toast === 'object' ? toast.launch : null },
        )
      }
      /** Waits until main sets the badge to `count`. */
      const badgeReaches = (count: number) =>
        within(
          app.evaluate(
            (_electron, want) =>
              new Promise<void>((reached) => {
                const stubs = globalThis.letterboxNotifyStubs
                const check = () => stubs?.badges.at(-1) === want && reached()
                stubs?.onBadge.push(check)
                check()
              }),
            count,
          ),
          `the badge reaching ${count}`,
        )
      // Each window's page errors, from the moment it opens.
      const errorsOf = new Map<Page, string[]>()
      app.on('window', (opened) => {
        const errors: string[] = []
        errorsOf.set(opened, errors)
        opened.on('pageerror', (error) => errors.push(error.message))
      })
      /** Closes the window on screen, chooses notification `index`, and resolves with the window it opens. */
      const chooseWithWindowClosed = async (index: number) => {
        const opened = app.waitForEvent('window', { timeout: WAIT_MS })
        await app.evaluate(
          ({ BrowserWindow }) =>
            new Promise<void>((closed) => {
              const shown = BrowserWindow.getAllWindows().find((window) => window.isVisible())
              shown?.once('closed', () => closed())
              shown?.close()
            }),
        )
        await choose(index)
        return opened
      }
      const asked = async () => {
        const stubs = await app.evaluate(() => {
          const { shown, closed, toasts, badges } = globalThis.letterboxNotifyStubs ?? {
            shown: [],
            closed: [],
            toasts: [],
            badges: [],
          }
          return { shown, closed, toasts, badges }
        })
        return stubs
      }
      await page.waitForFunction(() => window.letterboxDev !== undefined, null, { timeout: WAIT_MS })
      const sync = () =>
        within(
          page.evaluate(() => window.letterboxDev?.sync()),
          'a sync',
        )
      await page.evaluate(() =>
        window.letterbox?.onOpenConversation((threadId) => void (document.body.dataset.opened = threadId)),
      )

      await within(
        page.evaluate(() => window.letterboxDev?.deliver(1)),
        'a delivery from a machine',
      )
      equal((await asked()).shown, [], 'notify: mail from a machine shows no notification')

      sim.mailbox.deliver(mail('notify-lunch', ANA, LUNCH))
      await sync()
      const first = await asked()
      const lunch = await page.evaluate((subject) => window.letterboxDev?.threadOf(subject), LUNCH)
      equal(
        first.shown,
        [
          {
            id: lunch ?? '',
            title: ANA.name,
            body: process.platform === 'linux' ? 'Lunch &lt;next&gt; week &amp; more?' : LUNCH,
          },
        ],
        "notify: a person's mail that is my turn shows one notification, under its conversation's id: the sender, and the subject as plain text",
      )
      const badge = first.badges.at(-1) ?? -1
      equal(badge > 0, true, `notify: the badge counts the conversations that are my turn (${badge})`)

      sim.mailbox.deliver(mail('notify-lunch-again', ANA, `Re: ${LUNCH}`, { replyTo: ['notify-lunch'] }))
      await sync()
      const again = await asked()
      equal(again.shown.length, 2, 'notify: a newer reply in the conversation shows a notification')
      equal(again.closed, [ANA.name], 'notify: it replaces the one before, so the conversation shows one')
      equal(again.badges.at(-1), badge, 'notify: the badge counts the conversation once')

      sim.mailbox.deliver(mail('notify-other', BEN, BEN_SUBJECT))
      await sync()
      const withBen = await asked()
      equal(withBen.badges.at(-1), badge + 1, 'notify: a second conversation adds one to the badge')

      if (windows) {
        parsed = await toastsOf(page, withBen.toasts)
        const other = await page.evaluate((subject) => window.letterboxDev?.threadOf(subject), BEN_SUBJECT)
        equal(
          parsed,
          [
            toastFor(lunch, ANA.name, LUNCH),
            toastFor(lunch, ANA.name, `Re: ${LUNCH}`),
            toastFor(other, BEN.name, BEN_SUBJECT),
          ],
          "notify: on Windows each toast's XML parses back to the sender and the subject, and its launch value names the conversation",
        )
      }

      // The person chooses the reply's notification.
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.minimize())
      await choose(1)
      const opened = await page.waitForFunction(() => document.body.dataset.opened, null, { timeout: WAIT_MS })
      equal(await opened.jsonValue(), lunch, 'notify: choosing it tells the page to open that conversation')
      equal(
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isMinimized()),
        false,
        'notify: choosing it brings the window back',
      )
      equal(
        await opensIn(page, LUNCH),
        { place: 'People', chosen: lunch ?? null },
        'notify: the page opens that conversation in People, in the reader, with its row chosen',
      )

      // Opening it marks it read, which takes it off the badge.
      await badgeReaches(badge)

      // As on macOS: the window closes and the app stays up. A hidden window keeps Linux and
      // Windows from quitting with the last one. Then the notification times out, and the
      // person chooses it from the notification center.
      const reopened = app.waitForEvent('window', { timeout: WAIT_MS })
      await app.evaluate(
        ({ BrowserWindow }) =>
          new Promise<void>((closed) => {
            const [shown] = BrowserWindow.getAllWindows()
            // Kept on globalThis, so it lives until the app quits.
            Reflect.set(globalThis, 'letterboxKeepAlive', new BrowserWindow({ show: false }))
            shown?.once('closed', () => closed())
            shown?.close()
          }),
      )
      await app.evaluate(() => globalThis.letterboxNotifyStubs?.made[1]?.emit('close', { reason: 'timedOut' }))
      await choose(1)
      // The preload holds the id until the page's one listener (the renderer's chosen.ts) takes it.
      const next = await reopened
      equal(
        await opensIn(next, LUNCH),
        { place: 'People', chosen: lunch ?? null },
        'notify: with the window closed, choosing it opens a window whose page opens that conversation',
      )

      // Ben's conversation leaves People unread: his next message only copies the user, so it is
      // nobody's turn. Newer mail then pushes it below All mail's first window.
      await next.waitForFunction(() => window.letterboxDev !== undefined, null, { timeout: WAIT_MS })
      const ben = await next.evaluate((subject) => window.letterboxDev?.threadOf(subject), BEN_SUBJECT)
      const others = { to: [{ name: 'The Team', address: 'team@notify.example' }], cc: [seed.seed.address] }
      sim.mailbox.deliver(
        mail('notify-other-cc', BEN, `Re: ${BEN_SUBJECT}`, { replyTo: ['notify-other'], sentAt: later(1), ...others }),
      )
      for (let index = 0; index < 24; index += 1)
        sim.mailbox.deliver(
          mail(`notify-newer-${index}`, ANA, `Newer ${index}`, { sentAt: later(60 * (index + 1)), ...others }),
        )
      await within(
        next.evaluate(() => window.letterboxDev?.sync()),
        'a sync',
      )
      equal((await asked()).shown.length, 3, 'notify: mail that only copies the user shows no notification')

      // Its notification opens All mail at its row, far down, marks it read, and the arrow keys go on from it.
      const third = await chooseWithWindowClosed(2)
      const row = third.locator(`[data-list="mail"] [role="option"][data-row="${ben}"]`)
      await row.and(third.locator('[aria-selected="true"]')).waitFor({ timeout: WAIT_MS })
      const below = await third.locator('[data-list="mail"] [role="option"]').evaluateAll((rows, id) => {
        const ids = rows.map((element) => element.getAttribute('data-row'))
        return { after: ids[ids.indexOf(id ?? '') + 1] }
      }, ben)
      const offset = await third.locator('[data-list="mail"]').evaluate((list) => list.scrollTop)
      await third.keyboard.press('ArrowDown')
      await third
        .locator(`[data-list="mail"] [aria-selected="true"][data-row="${below.after}"]`)
        .waitFor({ timeout: WAIT_MS })
      // A selected row always looks read. Off it, it shows what the core holds.
      await row.and(third.locator('[data-unread="false"]')).waitFor({ timeout: WAIT_MS })
      // The person scrolls back to the top, past the loaded window. The list stays where they put it.
      const list = third.locator('[data-list="mail"]')
      await list.evaluate((element) => element.scrollTo({ top: 0 }))
      await third.evaluate(async () => {
        await window.letterboxDev?.settle()
        await window.letterboxDev?.settle()
        await new Promise((frame) => requestAnimationFrame(() => requestAnimationFrame(frame)))
      })
      equal(
        await list.evaluate((element) => element.scrollTop),
        0,
        'notify: scrolled away after the open, All mail stays where the person put it',
      )
      equal(
        [await placeOf(third), offset > 0, errorsOf.get(third) ?? ['no error list']],
        ['All mail', true, []],
        "notify: a conversation below All mail's first window opens there, scrolled to its row, marked read, and the next arrow key goes to the row under it",
      )

      // Lunch is gone by the time its notification opens a window: the page says so, quietly.
      sim.mailbox.expunge('notify-lunch')
      sim.mailbox.expunge('notify-lunch-again')
      await within(
        third.evaluate(() => window.letterboxDev?.sync()),
        'a sync',
      )
      const last = await chooseWithWindowClosed(1)
      const gone = last.getByText('This conversation is gone')
      await gone.waitFor({ timeout: WAIT_MS })
      equal(
        [
          await gone.getAttribute('data-thread'),
          await placeOf(last),
          await last.getByRole('alert').count(),
          errorsOf.get(last) ?? ['no error list'],
        ],
        [lunch, 'All mail', 0, []],
        'notify: a conversation gone before its notification opened a window opens All mail, whose reader says that one is gone, and nothing breaks',
      )
      // The person opens another row while the core has not yet said where Ben's sits. Every new
      // page from here holds its position request at its port until the check lets it go.
      await app.context().addInitScript(() => {
        const held: (() => void)[] = []
        const send = MessagePort.prototype.postMessage
        MessagePort.prototype.postMessage = function postMessage(this: MessagePort, ...args: [unknown]) {
          const [line] = args
          if (typeof line === 'string' && line.includes('"method":"position"'))
            return void held.push(() => send.apply(this, args))
          return send.apply(this, args)
        }
        Reflect.set(window, 'heldPositions', () => held.length)
        Reflect.set(window, 'releasePositions', () => held.splice(0).forEach((go) => go()))
      })
      const fifth = await chooseWithWindowClosed(2)
      await fifth.waitForFunction(() => Reflect.get(window, 'heldPositions')?.() === 1, null, { timeout: WAIT_MS })
      const top = fifth.locator('[data-list="mail"] [role="option"]').first()
      const other = await top.getAttribute('data-row')
      await top.click()
      await fifth.evaluate(async () => {
        Reflect.get(window, 'releasePositions')?.()
        await window.letterboxDev?.settle()
        await window.letterboxDev?.settle()
        await new Promise((frame) => requestAnimationFrame(() => requestAnimationFrame(frame)))
      })
      equal(
        [
          await fifth.locator('[data-list="mail"]').evaluate((element) => element.scrollTop),
          await fifth.evaluate(
            () => document.querySelector('[data-list="mail"] [aria-selected="true"]')?.getAttribute('data-row') ?? null,
          ),
          other === ben,
        ],
        [0, other, false],
        "notify: a row opened while the core answers where the notification's sits keeps the list where it is",
      )

      // Each new page asks for a core of its own. Quit once the last has one, not while main starts it.
      await untilLogged(run, (lines) => corePids(lines).length === 5, "the last page's core starting")
      checkQuit('notify', run, await quit(run), 5)
    },
    ['-r', activation],
  )
}
