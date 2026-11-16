// The preload: a thin bridge between the sandboxed page and main. It puts two things on
// `window.letterbox` (ShellBridge): the platform, for styling, and `connect`, which asks main
// for a core. Main answers with a MessagePort, which this passes to the page as a window
// message, because contextBridge cannot carry a port. Core messages never pass through here.

import { contextBridge, ipcRenderer } from 'electron'
import { PORT_MESSAGE, type ShellBridge } from '@letterbox/client/message-port'
import type { Channel } from '../shared/channels.ts'

/**
 * This document's id. The preload runs again for every document, so a reload gets a new one.
 * Main sends each port back with the id of the document that asked for it, and a port meant
 * for an earlier document in this frame is closed here, unheard.
 */
const documentId = crypto.randomUUID()

ipcRenderer.on('core:port' satisfies Channel, (event, asker: unknown) => {
  if (asker === documentId) return window.postMessage(PORT_MESSAGE, window.location.origin, event.ports)
  for (const port of event.ports) port.close()
})

contextBridge.exposeInMainWorld('letterbox', {
  platform: process.platform,
  connect: () => ipcRenderer.send('core:connect' satisfies Channel, documentId),
} satisfies ShellBridge)
