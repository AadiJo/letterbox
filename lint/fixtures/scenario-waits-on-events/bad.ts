// expect: letterbox/scenario-waits-on-events x5

// A timer is an error under any spelling: imported, bare, or read off globalThis.
import { setTimeout as sleep } from 'node:timers/promises'

export const nap = () => sleep(10)
export const later = () => new Promise((resolve) => setTimeout(resolve, 100))
export const often = (run: () => void) => setInterval(run, 10)
export const soon = (run: () => void) => setImmediate(run)
export const viaGlobal = (run: () => void) => globalThis.setTimeout(run, 10)
