// Native notifications and the dock or taskbar badge, from what the core tells main (core.ts).
//
//   notifications  one per `your-turn` the core sends, which it sends only for new mail from a
//                  person that makes it the user's turn. The text is the sender and the subject,
//                  nothing else. A conversation shows one at a time: a newer one replaces it.
//                  Choosing it brings the window forward and asks the page to open that
//                  conversation (`conversation:open`).
//   badge          how many conversations are the user's turn and unread. The dock on macOS, the
//                  launcher on Linux desktops that show counts, an overlay dot on Windows.
//
// Do not disturb: a notification goes through the OS's own notification center, which holds it
// back while do not disturb or Focus is on. Main does nothing that gets past that: no critical
// urgency, no notification that never times out, no sound of its own, no dock bounce or flash.
//
// The Electron check (packages/dev-host/src/electron-notify.ts) drives this with the
// notification API and the badge stubbed.

import { app, type BrowserWindow, nativeImage, Notification } from 'electron'
import type { YourTurn } from '@letterbox/protocol'
import type { Channel } from '../shared/channels.ts'

/** The notification each conversation shows now, by thread id. */
const shown = new Map<string, Notification>()

/** Text for a Linux notification body, where the notification server reads a few HTML tags. */
const plain = (text: string) =>
  process.platform === 'linux' ? text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;') : text

/** Shows the notification for one `your-turn`, replacing the conversation's earlier one. `window` is read when it is chosen. */
export function notifyYourTurn(event: YourTurn, window: () => BrowserWindow | undefined) {
  if (!Notification.isSupported()) return
  shown.get(event.threadId)?.close()
  const notification = new Notification({
    title: event.from.name ?? event.from.address,
    body: plain(event.subject),
    urgency: 'normal',
  })
  notification.on('click', () => {
    const open = window()
    if (!open) return
    if (open.isMinimized()) open.restore()
    open.show()
    open.focus()
    open.webContents.send('conversation:open' satisfies Channel, event.threadId)
  })
  notification.on('close', () => {
    if (shown.get(event.threadId) === notification) shown.delete(event.threadId)
  })
  shown.set(event.threadId, notification)
  notification.show()
}

/** Puts `count` on the badge, or clears it at 0. */
export function showBadge(count: number, window: BrowserWindow | undefined) {
  if (process.platform !== 'win32') return void app.setBadgeCount(count)
  // Windows has no badge count for a desktop app, only an overlay icon with a description.
  window?.setOverlayIcon(count === 0 ? null : dot(), count === 0 ? '' : `${count} conversations are your turn`)
}

/** A 16 by 16 red dot, for the Windows taskbar overlay. Pixels are BGRA. */
function dot() {
  const size = 16
  const pixels = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y += 1)
    for (let x = 0; x < size; x += 1) {
      if ((x - 7.5) ** 2 + (y - 7.5) ** 2 > 7.5 ** 2) continue
      pixels.set([0x30, 0x3b, 0xe5, 0xff], (y * size + x) * 4)
    }
  return nativeImage.createFromBitmap(pixels, { width: size, height: size })
}
