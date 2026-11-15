// expect: letterbox/no-ambient-time-or-randomness x15

// Importing a banned function is an error by itself, under any local name.
import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'

export const stamp = () => Date.now()
export const today = () => new Date()
export const roll = () => Math.random()
export const elapsed = () => performance.now()
export const id = () => randomUUID()
export const otherId = () => crypto.randomUUID()
export const nap = () => sleep(10)

export const later = (run: () => void) => setTimeout(run, 10)
export const often = (run: () => void) => setInterval(run, 10)
export const soon = (run: () => void) => setImmediate(run)

// Reaching the same things through globalThis, or without calling them yet, changes nothing.
export const viaGlobal = () => globalThis.Date.now()
export const viaGlobalTimer = (run: () => void) => globalThis.setTimeout(run, 10)
export const todayViaGlobal = () => new globalThis.Date()
export const clock = Date.now
