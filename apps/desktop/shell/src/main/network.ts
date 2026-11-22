// Tells the core when the network may be back, so an account it found offline pulls within
// seconds instead of after the rest of its backoff (schedule.rs in crates/core). Main hears of
// it three ways: the machine wakes, the screen unlocks, or `net.isOnline()` turns true. Electron
// has no event for the last, so main reads it every POLL_MS.
//
// Events that come together, as a wake and a reconnect do, fold into one hint, sent DEBOUNCE_MS
// after the last of them. The core does the rest: it ignores a hint for an account that is not
// offline, and pulls an offline one at most once per settle, so a network that flaps costs little.

import { net, powerMonitor } from 'electron'
import { log } from './log.ts'

/** How often main reads whether the machine is online. */
const POLL_MS = 5000

/** How long main waits after the last event before it sends the hint. */
const DEBOUNCE_MS = 1000

/** Calls `hint` each time the network may be back, at most once per DEBOUNCE_MS. Call it once the app is ready. */
export function watchNetwork(hint: () => void) {
  let timer: NodeJS.Timeout | undefined
  const soon = (why: string) => {
    log(`the network may be back: ${why}`)
    clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      hint()
    }, DEBOUNCE_MS)
  }
  powerMonitor.on('resume', () => soon('the machine woke'))
  powerMonitor.on('unlock-screen', () => soon('the screen unlocked'))
  let online = net.isOnline()
  // Unref'd, so the poll alone never keeps main running.
  setInterval(() => {
    const now = net.isOnline()
    if (now && !online) soon('the machine came online')
    online = now
  }, POLL_MS).unref()
}
