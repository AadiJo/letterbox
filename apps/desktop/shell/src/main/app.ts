// The main process. It owns the core process and the window:
//   - starts the core at once, while Chromium starts, so it is ready when the page asks;
//   - gives each page load its own core: a reload stops the core and starts another, as
//     the store allows one core at a time, and a port goes only to the document that asked;
//   - opens the core's sign-in pages in the browser, https only;
//   - saves and opens attachments for the page, which names them by blob id (attachments.ts);
//   - notifies of new mail that is the user's turn, and keeps the badge count (notify.ts);
//   - tells the core when the network may be back, so an offline account pulls soon (network.ts);
//   - on quit, closes the core's input, waits up to STOP_MS, then kills it by PID.
// If the core exits on its own, the page hears it through the port. Nothing restarts it.

import { join } from 'node:path'
import { getCompileCacheDir } from 'node:module'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  type IpcMainInvokeEvent,
  MessageChannelMain,
  shell,
  type WebContents,
  type WebFrameMain,
} from 'electron'
import type { AttachmentOutcome, PageOutcome } from '@letterbox/client/message-port'
import type { BlobId, ThreadId } from '@letterbox/protocol'
import type { Channel } from '../shared/channels.ts'
import { openAttachment, saveAttachment } from './attachments.ts'
import { coreCommand, readConfig } from './config.ts'
import { type CoreHooks, type CoreSession, startCore, STOP_MS } from './core.ts'
import { log, logTo } from './log.ts'
import { watchNetwork } from './network.ts'
import { applyBadge, notifyYourTurn, openFromNotifications, showBadge } from './notify.ts'
import { createWindow, lockNavigation, pageOrigin, registerScheme, serveRenderer } from './window.ts'

/**
 * Whether main opens `url` in the browser at all, for a sign-in page from the core or a page the
 * person chose, such as a sender's unsubscribe page: only https, and never with a user name or
 * password in it, which the browser would send. Anything else stays shut.
 */
const openable = (url: string) => {
  const parsed = URL.parse(url)
  if (parsed?.protocol !== 'https:') return void log('refused to open a url that is not https')
  if (parsed.username !== '' || parsed.password !== '')
    return void log('refused to open a url with a user name or password')
  return true
}

/** Hands an openable `url` to the browser. Resolves true once the OS has started it, false when it could not. */
async function launch(url: string) {
  try {
    await shell.openExternal(url)
    return true
  } catch {
    log('the OS could not open a page in the browser')
    return false
  }
}

/** Opens a sign-in page the core asks for, when it is openable. */
const openUrl = (url: string) => void (openable(url) && launch(url))

/** How often a window's page may open pages: one a second, and PAGES_A_MINUTE in any minute. */
const PAGE_GAP_MS = 1000
const PAGES_A_MINUTE = 5

/** When each window's page last opened pages, newest last, within the past minute. */
const pagesOpened = new WeakMap<WebContents, number[]>()

/** True when the page in `contents` may open another page now, by the limits above. */
function pageAllowed(contents: WebContents, now: number) {
  const opened = pagesOpened.get(contents) ?? []
  const recent = opened.filter((at) => now - at < 60_000)
  pagesOpened.set(contents, recent)
  const last = recent.at(-1)
  return recent.length < PAGES_A_MINUTE && (last === undefined || now - last >= PAGE_GAP_MS)
}

const dropped = () => log('dropped a core request from a page that has since reloaded or closed')

const read = readConfig(process.env)
if (!read.ok) {
  const message = read.problems.join('\n')
  // Before ready, Linux prints this to stderr and macOS and Windows show a dialog.
  dialog.showErrorBox('Letterbox cannot start', message)
  if (process.platform !== 'linux') console.error(message)
  app.exit(1)
} else {
  const { config } = read
  if (config.userData !== undefined) app.setPath('userData', config.userData)
  logTo(join(app.getPath('userData'), 'main.log'))
  const command = coreCommand(config.core, config.data ?? join(app.getPath('userData'), 'core'))
  log(`compile cache: ${getCompileCacheDir() ?? 'off'}`)

  // Windows shows a desktop app's notifications only under an app id.
  if (process.platform === 'win32') app.setAppUserModelId(process.execPath)

  /** The window, until it closes. macOS keeps the app and its core running without one. */
  let window: BrowserWindow | undefined
  /** Opens the window. Set once the app is ready. */
  let open: (() => void) | undefined

  /**
   * Brings the window forward and has its page open `threadId`. With no window, as on macOS
   * once the last one has closed, opens one first. Its page has not loaded yet, so its preload
   * holds the id until the page listens for it.
   */
  const openConversation = (threadId: ThreadId) => {
    if (!window) open?.()
    if (!window) return
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
    window.webContents.send('conversation:open' satisfies Channel, threadId)
  }
  openFromNotifications(openConversation)

  /** What main does with what each core tells it. The window is read when they run. */
  const hooks: CoreHooks = {
    openUrl,
    yourTurn: (event) => notifyYourTurn(event, openConversation),
    badge: (count) => showBadge(count, window),
  }
  /** The core, and whether a page has it yet. Undefined between stopping one and starting the next. */
  let core: { session: CoreSession; taken: boolean } | undefined = {
    session: startCore(command, hooks),
    taken: false,
  }
  /** The document that asked for a core last. Only its request may start a core or get a port. */
  let newest: string | undefined
  /** Page connects and the quit, one at a time, in order. */
  let queue = Promise.resolve()
  let quitting = false
  /** Stops main telling the core the network may be back (network.ts). Set once the app is ready. */
  let stopWatchingNetwork: (() => void) | undefined
  const origin = pageOrigin(config.renderer)

  /**
   * Gives the document `document` in `frame` a port to a core of its own. A page that has
   * reloaded since it asked is dropped, checked again after every wait: a reload keeps the
   * frame but is a new document, which asks for itself. A failure is logged, and the queue
   * goes on to the quit.
   */
  const connect = (frame: WebFrameMain, document: string) => {
    newest = document
    const wanted = () => !quitting && newest === document && !frame.isDestroyed()
    queue = queue
      .then(async () => {
        if (!wanted()) return dropped()
        if (core?.taken) {
          await core.session.stop()
          core = undefined
        }
        if (!wanted()) return dropped()
        core ??= { session: startCore(command, hooks), taken: false }
        core.taken = true
        const { port1, port2 } = new MessageChannelMain()
        core.session.connect(port1)
        frame.postMessage('core:port' satisfies Channel, document, [port2])
      })
      .catch((error: unknown) => log(`could not give the page a core: ${String(error)}`))
  }

  /** The top frame of our own window, showing our own page, or null for any other sender. */
  const ownPage = (event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>) => {
    const frame = event.senderFrame
    if (window === undefined || event.sender !== window.webContents || frame === null || frame.parent !== null)
      return null
    return frame.origin === origin ? { frame, window } : null
  }

  ipcMain.on('core:connect' satisfies Channel, (event, document: unknown) => {
    // Only our own page may have a core.
    const page = ownPage(event)
    if (!page || typeof document !== 'string') return
    log('a page asked for a core')
    connect(page.frame, document)
  })

  /**
   * Answers the page's save or open of an attachment with `act`, through the core the page
   * has. Only our own page may ask, and only by a blob id, which main passes to the core
   * as a JSON string and never reads as a path.
   */
  const attachments = (channel: Channel, act: typeof saveAttachment) =>
    ipcMain.handle(channel, (event, blobId: unknown): Promise<AttachmentOutcome> | AttachmentOutcome => {
      const page = ownPage(event)
      if (!page) {
        log(`refused ${channel} from a frame that is not our page`)
        return { ok: false, reason: 'failed' }
      }
      if (typeof blobId !== 'string' || blobId.length > 200) return { ok: false, reason: 'gone' }
      if (!core?.taken) return { ok: false, reason: 'failed' }
      // The core makes blob ids, so the page's string is branded here, where it goes back to the core.
      return act(core.session, page.window, blobId as BlobId)
    })
  attachments('attachment:save', saveAttachment)
  attachments('attachment:open', openAttachment)

  // A page the person chose to open, as a sender's unsubscribe page. Only our own page may ask.
  // At most one a second and a few a minute per window, so a page gone wrong cannot flood the
  // browser. The page hears which, or that the browser did not start, so its button can say so.
  ipcMain.handle('url:open' satisfies Channel, async (event, url: unknown): Promise<PageOutcome> => {
    const page = ownPage(event)
    if (!page) {
      log('refused url:open from a frame that is not our page')
      return 'refused-url'
    }
    if (typeof url !== 'string' || url.length > 4096 || !openable(url)) return 'refused-url'
    const now = Date.now()
    if (!pageAllowed(event.sender, now)) {
      log('refused url:open: too many pages too fast')
      return 'refused-rate'
    }
    // The slot is taken before the browser starts, so an ask that comes meanwhile counts it.
    pagesOpened.get(event.sender)?.push(now)
    return (await launch(url)) ? 'opened' : 'failed'
  })

  registerScheme()
  lockNavigation(origin)
  void app.whenReady().then(() => {
    const url = serveRenderer(config.renderer)
    open = () => {
      const opened = createWindow(url, import.meta.dirname)
      window = opened
      opened.on('closed', () => {
        if (window === opened) window = undefined
      })
      // The badge's count may have come before this window, which Windows shows it on.
      applyBadge(opened)
    }
    open()
    // One watcher for the app, across cores. The core between pages, if any, hears nothing:
    // its successor pulls at start anyway.
    stopWatchingNetwork = watchNetwork(() => core?.session.networkBack())
    // macOS keeps an app running with no window. Opening one gives its page a new core.
    app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && open?.())
  })

  app.on('window-all-closed', () => process.platform !== 'darwin' && app.quit())

  let stopped = false
  app.on('before-quit', (event) => {
    if (stopped) return
    event.preventDefault()
    if (quitting) return
    quitting = true
    stopWatchingNetwork?.()
    log(`quitting: stopping the core, for up to ${STOP_MS} ms`)
    void queue
      .then(() => core?.session.stop())
      .then(() => {
        stopped = true
        app.quit()
      })
  })
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => app.quit())
}
