// The main process. It owns the core process and the window:
//   - starts the core at once, while Chromium starts, so it is ready when the page asks;
//   - gives each page load its own core: a reload stops the core and starts another, as
//     the store allows one core at a time, and a port goes only to the document that asked;
//   - opens the core's sign-in pages in the browser, https only;
//   - saves and opens attachments for the page, which names them by blob id (attachments.ts);
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
  type WebFrameMain,
} from 'electron'
import type { AttachmentOutcome } from '@letterbox/client/message-port'
import type { BlobId } from '@letterbox/protocol'
import type { Channel } from '../shared/channels.ts'
import { openAttachment, saveAttachment } from './attachments.ts'
import { coreCommand, readConfig } from './config.ts'
import { type CoreSession, startCore, STOP_MS } from './core.ts'
import { log, logTo } from './log.ts'
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

  /** The core, and whether a page has it yet. Undefined between stopping one and starting the next. */
  let core: { session: CoreSession; taken: boolean } | undefined = {
    session: startCore(command, openUrl),
    taken: false,
  }
  /** The document that asked for a core last. Only its request may start a core or get a port. */
  let newest: string | undefined
  /** Page connects and the quit, one at a time, in order. */
  let queue = Promise.resolve()
  let quitting = false
  let window: BrowserWindow | undefined
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
        core ??= { session: startCore(command, openUrl), taken: false }
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
