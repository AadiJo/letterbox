// The preload: a thin bridge between the sandboxed page and main. It puts these on
// `window.letterbox` (ShellBridge): the platform, for styling; `connect`, which asks main
// for a core; and `onOpenConversation`, which tells the page which conversation a chosen
// notification names. Main answers `connect` with a MessagePort, which this passes to the
// page as a window message, because contextBridge cannot carry a port. Core messages never
// pass through here.

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
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

contextBridge.exposeInMainWorld('letterbox', {
  platform: process.platform,
  connect: () => ipcRenderer.send('core:connect' satisfies Channel, documentId),
  onOpenConversation: (listener) => {
    // Main sends the thread id the core put in its `your-turn`, so the string is branded here.
    const relay = (_event: IpcRendererEvent, threadId: unknown) =>
      typeof threadId === 'string' && listener(threadId as ThreadId)
    ipcRenderer.on('conversation:open' satisfies Channel, relay)
    return () => void ipcRenderer.off('conversation:open' satisfies Channel, relay)
  },
} satisfies ShellBridge)
