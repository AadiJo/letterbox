// The messages between client.ts and server.ts: JSON, one message per line.
//
// The client numbers its requests per socket and the server answers with the
// same id. An adapter call gets one `result` reply. A password sign-in gets one
// `signed-in` reply. An oauth sign-in gets `open-url`, then `signed-in` once the
// scenario approves or denies it. Closing the socket cancels a pending oauth attempt.

import type {
  AdapterFailure,
  ApplyResult,
  BodyResult,
  ChangesResult,
  Cursor,
  MessageRef,
  Mutation,
  Outcome,
  PageToken,
  SignInFailure,
  SnapshotPage,
} from '@letterbox/core/adapter'
import type { Dialect } from './contract.ts'

/** One adapter call, as sent to the server. */
export type Call =
  | { method: 'snapshot'; arg: PageToken | null }
  | { method: 'changes'; arg: Cursor }
  | { method: 'body'; arg: MessageRef }
  | { method: 'apply'; arg: Mutation }

/** The answer to one adapter call. `method` repeats the call's, so the client can narrow on it. */
export type CallResult =
  | { method: 'snapshot'; outcome: Outcome<SnapshotPage> }
  | { method: 'changes'; outcome: Outcome<ChangesResult> }
  | { method: 'body'; outcome: Outcome<BodyResult> }
  | { method: 'apply'; outcome: Outcome<ApplyResult> }

/** The answer to a call that never reached a usable mailbox. */
export const failedCall = (call: Call, failure: AdapterFailure): CallResult => ({
  method: call.method,
  outcome: { ok: false, failure },
})

/** What an adapter needs to work again after a core restart. The session string is this as JSON. */
export type Session = { address: string; dialect: Dialect; modify: boolean }

export type SignInResult = { ok: true; session: Session } | { ok: false; failure: SignInFailure }

/** A request before the client gives it an id. */
export type RequestBody =
  | { op: 'sign-in-password'; address: string; password: string }
  | { op: 'sign-in-oauth' }
  | { op: 'call'; address: string; call: Call }

export type Request = { id: number } & RequestBody

export type Reply =
  | { id: number; kind: 'open-url'; url: string }
  | { id: number; kind: 'signed-in'; result: SignInResult }
  | { id: number; kind: 'result'; result: CallResult }

const ops: readonly string[] = ['sign-in-password', 'sign-in-oauth', 'call'] satisfies Request['op'][]
const kinds: readonly string[] = ['open-url', 'signed-in', 'result'] satisfies Reply['kind'][]

/** Narrows parsed JSON to an object with string keys. Used on every string the core hands back. */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** True when `value` is an object with a number under `id` and one of `tags` under `tagKey`. */
const isEnvelope = (value: unknown, tagKey: 'op' | 'kind', tags: readonly string[]): boolean => {
  if (!isRecord(value)) return false
  const tag = value[tagKey]
  return typeof value.id === 'number' && typeof tag === 'string' && tags.includes(tag)
}

// Both ends of the socket are this package, so these two guards check the
// envelope (`id` plus `op` or `kind`) and trust the fields behind it.

/** Tells the server that a parsed line is a request. */
export const isRequest = (value: unknown): value is Request => isEnvelope(value, 'op', ops)

/** Tells the client that a parsed line is a reply. */
export const isReply = (value: unknown): value is Reply => isEnvelope(value, 'kind', kinds)

/** Turns one message into its line on the socket. */
export const encode = (message: Request | Reply): string => `${JSON.stringify(message)}\n`

/**
 * Splits a socket's text into lines. Feed it every chunk as it arrives.
 * It calls `onMessage` with the parsed JSON of each complete line.
 */
export const lineReader = (onMessage: (value: unknown) => void): ((chunk: string) => void) => {
  let pending = ''
  return (chunk) => {
    const lines = (pending + chunk).split('\n')
    pending = lines.pop() ?? ''
    for (const line of lines) if (line !== '') onMessage(JSON.parse(line))
  }
}
