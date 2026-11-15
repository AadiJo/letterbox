// The protocol between the core and every UI, for TypeScript clients.
//
// The types come from crates/protocol/src/lib.rs, through generated.ts. That Rust file
// is the only place the protocol is written by hand, and it lists the guarantees the
// core makes. This file adds only the lookup types a TypeScript client derives from it.

export * from './generated.ts'
import type { Query, Request, Response, Update } from './generated.ts'

/** Store revision. It rises on every change to the store and never repeats. */
export type Rev = number
/** ISO 8601 in UTC, for example "2026-11-14T23:04:01Z". */
export type Time = string

/** Each live view's query fields and answer, by view name. */
export type Queries = {
  [View in Query['view']]: {
    params: Omit<Extract<Query, { view: View }>, 'view'>
    result: Extract<Update, { view: View }>['data']
  }
}

/** Each request's fields, result and error, by method. */
export type Requests = {
  [Method in Request['method']]: {
    params: Omit<Extract<Request, { method: Method }>, 'method'>
    result: Extract<Response, { method: Method; ok: true }>['result']
    error: Extract<Response, { method: Method; ok: false }>['error']
  }
}
