// The notify run of the Electron check (electron-check.ts): new mail reaches the app's core
// through a sync, with main's notification API and badge stubbed inside main, so nothing
// reaches the desktop. It checks that mail from a machine stays quiet, that a person's mail
// that is the user's turn shows one notification with the sender and subject only, that a
// newer one in the same conversation replaces it, that the badge counts conversations and
// drops one once read, and that choosing a notification brings the window forward and tells
// the page to open it, even after it timed out and the window closed, as on macOS.

import type { ThreadId } from '@letterbox/protocol'
import type { SeedMessage } from '@letterbox/sim-provider/contract'
import { checkQuit, corePids, equal, quit, seed, untilLogged, WAIT_MS, withApp, within } from './electron-app.ts'
import type { DevServer } from './server.ts'
import type { RunningSim } from './sim.ts'

/** What the stubs in main were asked, kept on main's globalThis with the notifications made. */
type Stubs = {
  shown: { id: string; title: string; body: string }[]
  /** The title of each notification closed, as a newer one replaces it. */
  closed: string[]
  badges: number[]
  /** Every notification shown, so the check can choose one. */
  made: Electron.Notification[]
}

declare global {
  var letterboxNotifyStubs: Stubs | undefined
}

const ANA = { name: 'Ana Check', address: 'ana@notify.example' }
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

export const notifyRun = (sim: RunningSim, server: DevServer) =>
  withApp('notify', server.url, async (run) => {
    const { app, page } = run
    await app.evaluate(({ app: electron, Notification }) => {
      const stubs: Stubs = { shown: [], closed: [], badges: [], made: [] }
      globalThis.letterboxNotifyStubs = stubs
      Notification.isSupported = () => true
      Notification.prototype.show = function show(this: Electron.Notification) {
        stubs.shown.push({ id: this.id, title: this.title, body: this.body })
        stubs.made.push(this)
      }
      Notification.prototype.close = function close(this: Electron.Notification) {
        stubs.closed.push(this.title)
      }
      electron.setBadgeCount = (count?: number) => {
        stubs.badges.push(count ?? 0)
        return true
      }
    })
    const asked = async () => {
      const stubs = await app.evaluate(() => {
        const { shown, closed, badges } = globalThis.letterboxNotifyStubs ?? { shown: [], closed: [], badges: [] }
        return { shown, closed, badges }
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
      [{ id: lunch ?? '', title: 'Ana Check', body: 'Lunch &lt;next&gt; week &amp; more?' }],
      "notify: a person's mail that is my turn shows one notification, under its conversation's id: the sender, and the subject as plain text",
    )
    const badge = first.badges.at(-1) ?? -1
    equal(badge > 0, true, `notify: the badge counts the conversations that are my turn (${badge})`)

    sim.mailbox.deliver(mail('notify-lunch-again', ANA, `Re: ${LUNCH}`, { replyTo: ['notify-lunch'] }))
    await sync()
    const again = await asked()
    equal(again.shown.length, 2, 'notify: a newer reply in the conversation shows a notification')
    equal(again.closed, ['Ana Check'], 'notify: it replaces the one before, so the conversation shows one')
    equal(again.badges.at(-1), badge, 'notify: the badge counts the conversation once')

    sim.mailbox.deliver(mail('notify-other', { name: 'Ben Check', address: 'ben@notify.example' }, 'Quick question'))
    await sync()
    equal((await asked()).badges.at(-1), badge + 1, 'notify: a second conversation adds one to the badge')

    // The person chooses the reply's notification.
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.minimize()
      globalThis.letterboxNotifyStubs?.made[1]?.emit('click')
    })
    const opened = await page.waitForFunction(() => document.body.dataset.opened, null, { timeout: WAIT_MS })
    equal(await opened.jsonValue(), lunch, 'notify: choosing it tells the page to open that conversation')
    equal(
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isMinimized()),
      false,
      'notify: choosing it brings the window back',
    )

    await within(
      page.evaluate((subject) => window.letterboxDev?.markRead(subject), LUNCH),
      'marking it read',
    )
    equal((await asked()).badges.at(-1), badge, 'notify: reading a conversation takes it off the badge')

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
    await app.evaluate(() => {
      const reply = globalThis.letterboxNotifyStubs?.made[1]
      reply?.emit('close', { reason: 'timedOut' })
      reply?.emit('click')
    })
    const next = await reopened
    await next.waitForLoadState('domcontentloaded')
    const held = await within(
      next.evaluate(
        () =>
          new Promise<ThreadId>((resolve) => {
            window.letterbox?.onOpenConversation(resolve)
          }),
      ),
      'the new page hearing which conversation to open',
    )
    equal(held, lunch, 'notify: with the window closed, choosing it opens a window whose page opens that conversation')
    // The new page asks for a core of its own. Quit once it has one, not while main starts it.
    await untilLogged(run, (lines) => corePids(lines).length === 2, "the new page's core starting")
    checkQuit('notify', run, await quit(run), 2)
  })
