// The preload: a thin bridge between the sandboxed page and main. It puts two things on
// `window.letterbox` (ShellBridge): the platform, for styling, and `connect`, which asks main
// for a core. Main answers with a MessagePort, which this passes to the page as a window
// message, because contextBridge cannot carry a port. Core messages never pass through here.

import { contextBridge, ipcRenderer } from 'electron'
import { PORT_MESSAGE, type ShellBridge } from '@letterbox/client/message-port'
import type { Channel } from '../shared/channels.ts'

ipcRenderer.on('core:port' satisfies Channel, (event) => {
  window.postMessage(PORT_MESSAGE, window.location.origin, event.ports)
})

contextBridge.exposeInMainWorld('letterbox', {
  platform: process.platform,
  connect: () => ipcRenderer.send('core:connect' satisfies Channel),
} satisfies ShellBridge)
