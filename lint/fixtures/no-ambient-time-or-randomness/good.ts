// Time and ids come in through the Environment argument. This file must stay clean.

type Environment = { now(): string; nextId(prefix: string): string }

export const stamp = (env: Environment) => env.now()
export const threadId = (env: Environment) => env.nextId('thread')

// A date built from a value is not a clock reading. Neither is the rest of Date and Math.
export const parse = (iso: string) => new Date(iso)
export const millis = (iso: string) => Date.parse(iso)
export const addSeconds = (iso: string, seconds: number) => new Date(Date.parse(iso) + seconds * 1000).toISOString()
export const half = (total: number) => Math.floor(total / 2)
