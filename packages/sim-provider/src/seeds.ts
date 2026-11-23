// Named mailboxes for the dev loop (packages/dev-host). Each one is a seed the sim provider
// holds, the fixed time the core runs at, and the new mail a dev hook delivers.
//
// Scenarios build their own seeds in packages/harness. These are for looking at the UI.

import { fileURLToPath } from 'node:url'
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

/** A remote image a seed's mail names, and the file under seeds/images the dev host's fake web answers it with. */
export type SeedImage = { url: string; mime: 'image/png' | 'image/jpeg'; file: string }

export type DevSeed = {
  dialect: Dialect
  /** The time core-sim starts at (its --now). The UI measures ages from it, so captures stay the same. */
  now: Time
  seed: Seed
  /** The automated message the dev hook delivers as its `n`th, counting from 0. Each one is new mail. */
  delivery(n: number): SeedMessage
  /** Every conversation with a person, so a check knows what the core should show. */
  conversations: readonly PersonConversation[]
  /** The remote images its mail names that the dev host's fake web serves. Every other URL answers 404. */
  images: readonly SeedImage[]
}

/** Where a seed image's file is on disk. */
export const imagePath = (image: SeedImage) => fileURLToPath(new URL(`./seeds/images/${image.file}`, import.meta.url))

export const devSeeds = { 'people-first': peopleFirst, updates, many } satisfies Record<string, DevSeed>

export type DevSeedName = keyof typeof devSeeds

export const isDevSeedName = (name: string): name is DevSeedName => Object.hasOwn(devSeeds, name)
