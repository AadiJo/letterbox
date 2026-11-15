// Time comes into the core through this one object, so a test run can fix it
// and produce the same transcript every time. Nothing else in the core may read
// the wall clock or make a random value. The lint rule
// letterbox/no-ambient-time-or-randomness enforces that. Ids need no randomness:
// the store counts them (see store.ts).

import type { Time } from '@letterbox/protocol'

export type Environment = {
  /** The current time. */
  now(): Time
}

/** The real clock. Used when the core runs for a person. */
export const systemEnvironment = (): Environment => ({
  now: () => new Date().toISOString(),
})

/**
 * A clock that starts at `start` and moves forward one second on each read.
 * Used by the harness so every run is repeatable and events stay in order.
 */
export const fixedEnvironment = (start: Time): Environment => {
  let millis = Date.parse(start)
  return {
    now: () => {
      millis += 1000
      return new Date(millis).toISOString()
    },
  }
}
