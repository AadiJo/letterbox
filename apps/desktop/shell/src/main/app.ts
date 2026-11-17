// The main process. It owns the core process and the window:
//   - starts the core at once, while Chromium starts, so it is ready when the page asks;
//   - gives each page load its own core: a reload stops the core and starts another, as
//     the store allows one core at a time, and a port goes only to the document that asked;
//   - opens the core's sign-in pages in the browser, https only;
//   - notifies of new mail that is the user's turn, and keeps the badge count (notify.ts);
//   - on quit, closes the core's input, waits up to STOP_MS, then kills it by PID.
// If the core exits on its own, the page hears it through the port. Nothing restarts it.

import { join } from 'node:path'
import { getCompileCacheDir } from 'node:module'
import { app, BrowserWindow, dialog, ipcMain, MessageChannelMain, shell, type WebFrameMain } from 'electron'
import type { Channel } from '../shared/channels.ts'
import { coreCommand, readConfig } from './config.ts'
import { type CoreHooks, type CoreSession, startCore, STOP_MS } from './core.ts'
import { log, logTo } from './log.ts'
import { notifyYourTurn, showBadge } from './notify.ts'
import { createWindow, lockNavigation, pageOrigin, registerScheme, serveRenderer } from './window.ts'

/** Opens a sign-in page from the core in the browser. Only https: anything else stays shut. */
const openUrl = (url: string) => {
  if (URL.parse(url)?.protocol !== 'https:') return log('refused to open a url from the core that is not https')
  void shell.openExternal(url)
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

  let window: BrowserWindow | undefined
  /** What main does with what each core tells it. The window is read when they run. */
  const hooks: CoreHooks = {
    openUrl,
    yourTurn: (event) => notifyYourTurn(event, () => window),
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

  ipcMain.on('core:connect' satisfies Channel, (event, document: unknown) => {
    // Only the top frame of our own window, showing our own page, may have a core.
    const frame = event.senderFrame
    if (window === undefined || event.sender !== window.webContents || frame === null || frame.parent !== null) return
    if (frame.origin !== origin || typeof document !== 'string') return
    log('a page asked for a core')
    connect(frame, document)
  })

  registerScheme()
  lockNavigation(origin)
  void app.whenReady().then(() => {
    const url = serveRenderer(config.renderer)
    const open = () => {
      window = createWindow(url, import.meta.dirname)
    }
    open()
    // macOS keeps an app running with no window. Opening one gives its page a new core.
    app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && open())
  })

  app.on('window-all-closed', () => process.platform !== 'darwin' && app.quit())

  let stopped = false
  app.on('before-quit', (event) => {
    if (stopped) return
    event.preventDefault()
    if (quitting) return
    quitting = true
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
