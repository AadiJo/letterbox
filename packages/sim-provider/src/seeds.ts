// Named mailboxes for the dev loop (packages/dev-host). Each one is a seed the sim provider
// holds, the fixed time the core runs at, and the new mail a dev hook delivers.
//
// Scenarios build their own seeds in packages/harness. These are for looking at the UI.

import type { Dialect, Seed, SeedMessage } from './contract.ts'
import type { Time } from '@letterbox/protocol'
import { many } from './seeds/many.ts'
import { peopleFirst } from './seeds/people-first.ts'
import { updates } from './seeds/updates.ts'

/** One conversation with a person, as a seed describes it. The core works out the turn itself. */
export type PersonConversation = {
  subject: string
  /** Whose turn the seed means it to be. */
  turn: 'mine' | 'theirs'
  /** When its last message was sent. */
  lastAt: Time
}

export type DevSeed = {
  dialect: Dialect
  /** The time core-sim starts at (its --now). The UI measures ages from it, so captures stay the same. */
  now: Time
  seed: Seed
  /** The automated message the dev hook delivers as its `n`th, counting from 0. Each one is new mail. */
  delivery(n: number): SeedMessage
  /** Every conversation with a person, so a check knows what the core should show. */
  conversations: readonly PersonConversation[]
}

export const devSeeds = { 'people-first': peopleFirst, updates, many } satisfies Record<string, DevSeed>

export type DevSeedName = keyof typeof devSeeds

export const isDevSeedName = (name: string): name is DevSeedName => Object.hasOwn(devSeeds, name)
