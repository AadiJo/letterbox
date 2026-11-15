// Stands in for packages/core/src/clock.ts, the one file that may read the clock and make
// random ids. .oxlintrc.json exempts both paths in the same `excludeFiles` list, so this
// file must stay clean.

import { randomUUID } from 'node:crypto'

export const now = () => new Date().toISOString()
export const millis = () => Date.now()
export const nextId = (prefix: string) => `${prefix}_${randomUUID()}`
