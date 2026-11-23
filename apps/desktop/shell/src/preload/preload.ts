// The preload: a thin bridge between the sandboxed page and main. It puts these on
// `window.letterbox` (ShellBridge): the platform, for styling; `connect`, which asks main
// for a core; `saveAttachment` and `openAttachment`, which pass a blob id to main and hand
// back what happened, never a path; `onOpenConversation`, which tells the page which
// conversation a chosen notification names, holding one that came before the page listened;
// and `openPage`, which passes a url the person chose to main, to open in the browser, and hands
// back whether main opened it.
// Main answers `connect` with a MessagePort, which this passes to the page as a window
// message, because contextBridge cannot carry a port. Core messages never pass through here.

import { contextBridge, ipcRenderer } from 'electron'
import { PORT_MESSAGE, type ShellBridge } from '@letterbox/client/message-port'
import type { ThreadId } from '@letterbox/protocol'
import type { Channel } from '../shared/channels.ts'

/**
 * This document's id. The preload runs again for every document, so a reload gets a new one.
 * Main sends each port back with the id of the document that asked for it, and a port meant
 * for an earlier document in this frame is closed here, unheard. It uses getRandomValues,
 * which, unlike randomUUID, also works on a plain http page outside loopback.
 */
const documentId = Array.from(crypto.getRandomValues(new Uint32Array(4)), (part) => part.toString(36)).join('-')

ipcRenderer.on('core:port' satisfies Channel, (event, asker: unknown) => {
  if (asker === documentId) return window.postMessage(PORT_MESSAGE, window.location.origin, event.ports)
  for (const port of event.ports) port.close()
})

/**
 * The page's listeners for conversation:open, and the conversation main asked for before
 * the page had one. A window that a notification opened gets its id before its page has
 * loaded, so the id waits here for the first listener.
 */
const listeners = new Set<(threadId: ThreadId) => void>()
let held: ThreadId | undefined
ipcRenderer.on('conversation:open' satisfies Channel, (_event, threadId: unknown) => {
  // Main sends the thread id the core put in its `your-turn`, so the string is branded here.
  if (typeof threadId !== 'string') return
  if (listeners.size === 0) held = threadId as ThreadId
  for (const listener of listeners) listener(threadId as ThreadId)
})

contextBridge.exposeInMainWorld('letterbox', {
  platform: process.platform,
  connect: () => ipcRenderer.send('core:connect' satisfies Channel, documentId),
  saveAttachment: (blobId) => ipcRenderer.invoke('attachment:save' satisfies Channel, blobId),
  openAttachment: (blobId) => ipcRenderer.invoke('attachment:open' satisfies Channel, blobId),
  onOpenConversation: (listener) => {
    // A fresh function per call, so the same listener can listen twice and stop each once.
    const each = (threadId: ThreadId) => listener(threadId)
    listeners.add(each)
    if (held !== undefined) {
      const threadId = held
      held = undefined
      each(threadId)
    }
    return () => void listeners.delete(each)
  },
  openPage: (url) => ipcRenderer.invoke('url:open' satisfies Channel, url),
} satisfies ShellBridge)
