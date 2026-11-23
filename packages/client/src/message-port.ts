// A Transport over a MessagePort, for a UI whose host process hands it a port to the core:
// the desktop shell (apps/desktop/shell). The host is a byte pipe. Each string it posts is
// one line the core wrote, a JSON protocol message, and each string the UI posts is one
// line for the core's input. Once the core is gone, the host posts one `{ ended }` frame.
//
// Nothing here reads a global until it is called, so the module loads in Hermes too.

import type { AttachmentError, BlobId, CoreMessage, ThreadId } from '@letterbox/protocol'
import type { Listener, Transport } from './client.ts'

/** What the host posts on the port: a line the core wrote, or why the core is gone. */
export type HostFrame = string | { ended: string }

/** The window message that carries the port from the shell's preload to the page. */
export const PORT_MESSAGE = 'letterbox:core-port'

/**
 * What saving or opening an attachment came to. Besides the core's own reasons:
 *   cancelled  the person closed the save dialog
 *   declined   the person chose not to open a file that can run code
 *   failed     the file could not be written or opened, or the core went away
 */
export type AttachmentOutcome =
  | { ok: true }
  | { ok: false; reason: AttachmentError | 'cancelled' | 'declined' | 'failed' }

/** What the desktop shell's preload puts on `window.letterbox`. A plain browser tab has none. */
export type ShellBridge = {
  /** The OS as Node names it, such as 'darwin', for styling that differs by platform. */
  platform: string
  /** Asks the shell for a port to a core. The port arrives as a PORT_MESSAGE window message. */
  connect(): void
  /** Asks where to save one attachment with the native dialog, and saves it there. */
  saveAttachment(blobId: BlobId): Promise<AttachmentOutcome>
  /** Opens one attachment with the app the OS picks for its type, after a warning for one that can run code. */
  openAttachment(blobId: BlobId): Promise<AttachmentOutcome>
  /**
   * Calls `listener` with the conversation each time the person chooses a notification for it,
   * after the shell has brought the window forward. A conversation chosen before the page
   * listened, as when the choice opened this window, goes to the first listener at once.
   * Returns a function that stops listening.
   */
  onOpenConversation(listener: (threadId: ThreadId) => void): () => void
  /**
   * Opens `url` in the person's browser, as when they choose to open a sender's unsubscribe
   * page. Main opens https only, with no user name or password, a few at a time per window,
   * through the OS, and says which.
   */
  openPage(url: string): Promise<PageOutcome>
}

/**
 * What main did with a page the person chose to open: opened it in the browser, refused it as
 * too soon after others or as a URL it opens for no one, or failed, when the OS could not
 * start the browser.
 */
export type PageOutcome = 'opened' | 'refused-rate' | 'refused-url' | 'failed'

/**
 * Asks the shell for a port to a core and resolves with it. It listens before it asks, so
 * the port cannot arrive unheard. Only a message this window posted to itself counts.
 */
export function shellPort(shell: ShellBridge): Promise<MessagePort> {
  return new Promise((resolve) => {
    const take = (event: MessageEvent) => {
      const [port] = event.ports
      if (event.source !== window || event.data !== PORT_MESSAGE || port === undefined) return
      window.removeEventListener('message', take)
      resolve(port)
    }
    window.addEventListener('message', take)
    shell.connect()
  })
}

/**
 * Talks to the core through `port`, which may still be on its way. Messages sent before it
 * arrives wait, and go in order once it does. When the host says the core is gone, or the
 * port closes, the client's waits reject with the reason.
 */
export function messagePortTransport(port: MessagePort | Promise<MessagePort>): Transport {
  const unsent: string[] = []
  let open: MessagePort | undefined
  let listener: Listener | undefined
  let ended = false

  const end = (reason: string) => {
    if (ended) return
    ended = true
    listener?.end(new Error(reason))
    open?.close()
  }

  const receive = (frame: unknown) => {
    if (ended) return
    if (typeof frame === 'object' && frame !== null && 'ended' in frame && typeof frame.ended === 'string') {
      return end(frame.ended)
    }
    if (typeof frame !== 'string') return end('the shell sent a frame that is neither a core line nor an end')
    let message: CoreMessage
    try {
      // The host passes the core's own lines on unchanged. The scenarios check every message
      // the core sends against the protocol, so the client takes them as they come.
      message = JSON.parse(frame)
    } catch {
      return end(`the core sent a line that is not JSON: ${frame}`)
    }
    listener?.receive(message)
  }

  void Promise.resolve(port).then(
    (given) => {
      if (ended) return given.close()
      open = given
      given.addEventListener('message', (event) => receive(event.data))
      // Chromium fires `close` when the other end of the port goes away with the host.
      given.addEventListener('close', () => end('the shell closed the port to the core'))
      given.start()
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a MessagePort has no origin to name; only window.postMessage takes one
      for (const line of unsent.splice(0)) given.postMessage(line)
    },
    (error: unknown) => end(`the shell gave no port to the core: ${String(error)}`),
  )

  return {
    send: (message) => {
      if (ended) throw new Error('the connection to the core is closed')
      const line = JSON.stringify(message)
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a MessagePort has no origin to name; only window.postMessage takes one
      if (open) open.postMessage(line)
      else unsent.push(line)
    },
    listen: (given) => {
      listener = given
    },
  }
}
