// Native notifications and the dock or taskbar badge, from what the core tells main (core.ts).
//
//   notifications  one per `your-turn` the core sends, which it sends only for new mail from a
//                  person that makes it the user's turn. The text is the sender and the subject,
//                  nothing else. Each carries its conversation's thread id as its own id, so a
//                  conversation shows one at a time: a newer one replaces it, on screen and in
//                  the notification center. Choosing it calls `open` with the thread id, which
//                  brings a window forward and has its page open the conversation (app.ts).
//   badge          how many conversations are the user's turn and unread, leaving out those
//                  old enough to have moved to Let go. The dock on macOS, the
//                  launcher on Linux desktops that show counts, an overlay dot on Windows.
//
// A notification stays in `shown` until a newer one for its conversation replaces it, not
// only while it is on screen: the center keeps it after it times out, and a click from there
// reaches the object only while it is alive. On Windows a click from the Action Center can
// come after the object is gone, or start the app, so there `Notification.handleActivation`
// takes every click, and the toast's launch value names the thread.
//
// Do not disturb: a notification goes through the OS's own notification center, which holds it
// back while do not disturb or Focus is on. Main does nothing that gets past that: no critical
// urgency, no notification that never times out, no sound of its own, no dock bounce or flash.
//
// The Electron check (packages/dev-host/src/electron-notify.ts) drives this with the
// notification API and the badge stubbed.

import { app, type BrowserWindow, nativeImage, Notification } from 'electron'
import type { ThreadId, YourTurn } from '@letterbox/protocol'

/** The notification each conversation shows, by thread id. */
const shown = new Map<string, Notification>()

/** The badge's count, kept for a window that opens after it came. */
let count = 0

const windows = process.platform === 'win32'

/** Text for a Linux notification body, where the notification server reads a few HTML tags. */
const plain = (text: string) =>
  process.platform === 'linux' ? text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;') : text

/** Text inside XML. */
const xml = (text: string) =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')

/** The launch value of a Windows toast for a conversation. `threadOfLaunch` reads it back. */
const launchFor = (threadId: string) => new URLSearchParams({ thread: threadId }).toString()

/** The thread a Windows toast's launch value names, if it is one of ours. */
const threadOfLaunch = (launch: string) => new URLSearchParams(launch).get('thread') ?? undefined

/**
 * On Windows, has every notification click, from a toast or the Action Center, call `open`
 * with its conversation. Call once at start. Elsewhere each notification's own click does.
 */
export function openFromNotifications(open: (threadId: ThreadId) => void) {
  if (!windows) return
  // The launch value comes from a toast this app made, so its thread id is one the core made.
  Notification.handleActivation(({ arguments: launch }) => {
    const threadId = threadOfLaunch(launch)
    if (threadId !== undefined) open(threadId as ThreadId)
  })
}

/** Shows the notification for one `your-turn`, replacing the conversation's earlier one. */
export function notifyYourTurn(event: YourTurn, open: (threadId: ThreadId) => void) {
  if (!Notification.isSupported()) return
  shown.get(event.threadId)?.close()
  const title = event.from.name ?? event.from.address
  const notification = new Notification({
    id: event.threadId,
    title,
    body: plain(event.subject),
    urgency: 'normal',
    // A plain toast with the same text, and a launch value that names the thread.
    ...(windows && {
      toastXml: `<toast launch="${xml(launchFor(event.threadId))}"><visual><binding template="ToastGeneric"><text>${xml(title)}</text><text>${xml(event.subject)}</text></binding></visual></toast>`,
    }),
  })
  if (!windows) notification.on('click', () => open(event.threadId))
  shown.set(event.threadId, notification)
  notification.show()
}

/** Puts `next` on the badge, or clears it at 0, and keeps it for `applyBadge`. */
export function showBadge(next: number, window: BrowserWindow | undefined) {
  count = next
  applyBadge(window)
}

/** Puts the last count on the badge. Call it when a window opens: Windows shows it on the window. */
export function applyBadge(window: BrowserWindow | undefined) {
  if (!windows) return void app.setBadgeCount(count)
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
