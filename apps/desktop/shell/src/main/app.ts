// The main process. It owns the core process and the window:
//   - starts the core at once, while Chromium starts, so it is ready when the page asks;
//   - gives each page load its own core: a reload stops the core and starts another, as
//     the store allows one core at a time;
//   - opens the core's sign-in pages in the browser, https only;
//   - on quit, closes the core's input, waits up to STOP_MS, then kills it by PID.
// If the core exits on its own, the page hears it through the port. Nothing restarts it.

import { join } from 'node:path'
import { getCompileCacheDir } from 'node:module'
import { app, BrowserWindow, dialog, ipcMain, MessageChannelMain, shell, type WebContents } from 'electron'
import type { Channel } from '../shared/channels.ts'
import { coreCommand, readConfig } from './config.ts'
import { type CoreSession, startCore, STOP_MS } from './core.ts'
import { log, logTo } from './log.ts'
import { createWindow, lockNavigation, registerScheme, serveRenderer } from './window.ts'

/** Opens a sign-in page from the core in the browser. Only https: anything else stays shut. */
const openUrl = (url: string) => {
  if (URL.parse(url)?.protocol !== 'https:') return log('refused to open a url from the core that is not https')
  void shell.openExternal(url)
}

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

  let core: CoreSession = startCore(command, openUrl)
  /** True once a page has the current core. The next page gets a new one. */
  let taken = false
  /** Page connects and the quit, one at a time, in order. */
  let queue = Promise.resolve()
  let quitting = false
  let window: BrowserWindow | undefined

  /** Hands `page` a port to a core of its own. A failure is logged, and the queue goes on to the quit. */
  const connect = (page: WebContents) => {
    queue = queue
      .then(async () => {
        if (quitting || page.isDestroyed()) return
        if (taken) {
          await core.stop()
          core = startCore(command, openUrl)
        }
        taken = true
        const { port1, port2 } = new MessageChannelMain()
        core.connect(port1)
        page.postMessage('core:port' satisfies Channel, null, [port2])
      })
      .catch((error: unknown) => log(`could not give the page a core: ${String(error)}`))
  }

  ipcMain.on('core:connect' satisfies Channel, (event) => {
    // Only the top frame of our own window may have a core.
    if (window === undefined || event.sender !== window.webContents || event.senderFrame?.parent !== null) return
    connect(event.sender)
  })

  registerScheme()
  lockNavigation()
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
      .then(() => core.stop())
      .then(() => {
        stopped = true
        app.quit()
      })
  })
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => app.quit())
}
