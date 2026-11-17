// The renderer's only clock. Everything that shows or compares a time reads "now" here.
//
// The protocol carries no clock, so in the dev loop "now" is the sim's fixed time, which
// packages/dev-host passes in as VITE_LETTERBOX_NOW (core-sim's --now). Captures of the
// same mailbox then show the same ages on any day. Anywhere else it is the system clock.
// lint/rules/renderer-clock.ts keeps other files from reading the time themselves.

import { useSyncExternalStore } from 'react'

const MINUTE = 60_000
const fixed = import.meta.env.VITE_LETTERBOX_NOW

/** Milliseconds since the epoch. */
export const now = () => (fixed === undefined ? Date.now() : Date.parse(fixed))

const watchers = new Set<() => void>()
let ticker: ReturnType<typeof setInterval> | undefined

/** Ticks once a minute while anyone watches, and never when the time is fixed. */
const subscribe = (onChange: () => void) => {
  watchers.add(onChange)
  if (fixed === undefined) ticker ??= setInterval(() => watchers.forEach((watcher) => watcher()), MINUTE)
  return () => {
    watchers.delete(onChange)
    if (watchers.size > 0 || ticker === undefined) return
    clearInterval(ticker)
    ticker = undefined
  }
}

/** "Now" to the minute, for a component that shows ages. It re-renders when the minute changes. */
export function useNow() {
  return useSyncExternalStore(subscribe, () => Math.floor(now() / MINUTE) * MINUTE)
}

const SECOND = 1000
const secondWatchers = new Set<() => void>()
let secondTicker: ReturnType<typeof setInterval> | undefined

/** Ticks once a second while anyone watches, and never when the time is fixed. */
const subscribeSeconds = (onChange: () => void) => {
  secondWatchers.add(onChange)
  if (fixed === undefined) secondTicker ??= setInterval(() => secondWatchers.forEach((watcher) => watcher()), SECOND)
  return () => {
    secondWatchers.delete(onChange)
    if (secondWatchers.size > 0 || secondTicker === undefined) return
    clearInterval(secondTicker)
    secondTicker = undefined
  }
}

/** Whole seconds from now until `until` (an ISO time), never below 0, for a countdown such as a send's undo window. */
export function useSecondsUntil(until: string) {
  return useSyncExternalStore(subscribeSeconds, () => secondsUntil(until))
}

/** The same, read once, for an event handler. */
export const secondsUntil = (until: string) => Math.max(0, Math.ceil((Date.parse(until) - now()) / SECOND))
