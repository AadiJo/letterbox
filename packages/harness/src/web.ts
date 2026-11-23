// The fake web every scenario's core fetches remote images from. core-sim's `--web` sends each
// image request here over plain http, `https://host/path?q` as `/host/path?q` (see HttpsWeb in
// crates/host/src/web.rs). A scenario says what each URL answers and reads back every URL the
// core asked for, so it can show that a tracker, or a URL the core never listed, was never fetched.
// The fake answers name lookups too, at `/.dns/<name>`: a public stand-in address unless the
// scenario points the name elsewhere, so it can show that a private address is never connected to.
// It answers TXT lookups at `/.txt/<name>`, such as a DKIM key's, with the records a scenario
// set, and none for any other name. A one-click unsubscribe's POST comes as a POST, which the
// fake answers from the same table and keeps apart from the GETs (`posted`).
// A scenario can hold a URL's answer, to act while the core waits for it.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

/** What one URL answers: an image's bytes and type, a redirect, or an error status. */
export type WebAnswer =
  | { kind: 'body'; mime: string; bytes: Buffer }
  | { kind: 'redirect'; location: string }
  | { kind: 'status'; status: number }

export type FakeWeb = {
  /** The base URL core-sim's `--web` takes. */
  url: string
  /** Sets what `url`, an https URL, answers. Any other URL answers 404. */
  serve(url: string, answer: WebAnswer): void
  /** Sets the addresses `name` resolves to. Every other name resolves to PUBLIC. */
  resolve(name: string, addresses: readonly string[]): void
  /** Sets the TXT records of `name`, written without a trailing dot. Every other name has none. */
  txt(name: string, records: readonly string[]): void
  /**
   * Holds the answer to `url` until the returned release runs. `arrived` resolves once a
   * request for it is waiting, so a scenario acts while the core waits, never on a timer.
   */
  hold(url: string): { arrived: Promise<void>; release: () => void }
  /** Every URL the core asked for with a GET, as https URLs, in the order the requests came. */
  requested(): string[]
  /** Every POST, in the order they came: its URL, its Content-Type and its body. */
  posted(): Post[]
  /** Every name the core looked up TXT records for, without the trailing dot, in order. */
  lookups(): string[]
  close(): Promise<void>
}

/** One POST the fake got. */
export type Post = { url: string; type: string | null; body: string }

/** The address every name resolves to unless a scenario says otherwise: a public one, never connected to. */
const PUBLIC = '93.184.215.14'

/** Starts the fake web on a free port of 127.0.0.1. */
export async function startFakeWeb(): Promise<FakeWeb> {
  const answers = new Map<string, WebAnswer>()
  const names = new Map<string, readonly string[]>()
  const held = new Map<string, { arrive: () => void; waiting: (() => void)[] }>()
  const requested: string[] = []
  const records = new Map<string, readonly string[]>()
  const posted: Post[] = []
  const lookups: string[] = []
  const answer = (url: string, response: ServerResponse) => {
    const found = answers.get(url) ?? { kind: 'status', status: 404 }
    if (found.kind === 'body') response.writeHead(200, { 'content-type': found.mime }).end(found.bytes)
    else if (found.kind === 'redirect') response.writeHead(302, { location: found.location }).end()
    else response.writeHead(found.status).end()
  }
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const lookup = /^\/\.dns\/(.+)$/.exec(request.url ?? '')
    if (lookup?.[1] !== undefined) {
      response.writeHead(200, { 'content-type': 'text/plain' }).end((names.get(lookup[1]) ?? [PUBLIC]).join('\n'))
      return
    }
    const txt = /^\/\.txt\/(.+?)\.?$/.exec(request.url ?? '')
    if (txt?.[1] !== undefined) {
      lookups.push(txt[1])
      response.writeHead(200, { 'content-type': 'text/plain' }).end((records.get(txt[1]) ?? []).join('\n'))
      return
    }
    const url = `https:/${request.url ?? '/'}`
    if (request.method === 'POST') {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        const type = request.headers['content-type'] ?? null
        posted.push({ url, type, body: Buffer.concat(chunks).toString() })
        const leaks = ['cookie', 'referer', 'authorization'].filter((name) => request.headers[name] !== undefined)
        if (leaks.length > 0) response.writeHead(400).end(`sent ${leaks.join(', ')}`)
        else answer(url, response)
      })
      return
    }
    requested.push(url)
    // The core must send nothing that identifies the reader or the page.
    const leaks = ['cookie', 'referer', 'authorization'].filter((name) => request.headers[name] !== undefined)
    if (leaks.length > 0) {
      response.writeHead(400).end(`sent ${leaks.join(', ')}`)
      return
    }
    const hold = held.get(url)
    if (hold === undefined) return answer(url, response)
    hold.waiting.push(() => answer(url, response))
    hold.arrive()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('the fake web listens on a TCP port')
  return {
    url: `http://127.0.0.1:${address.port}`,
    serve: (url, found) => void answers.set(url, found),
    resolve: (name, addresses) => void names.set(name, addresses),
    txt: (name, found) => void records.set(name, found),
    hold: (url) => {
      const { promise: arrived, resolve: arrive } = Promise.withResolvers<void>()
      const hold = { arrive, waiting: [] as (() => void)[] }
      held.set(url, hold)
      return {
        arrived,
        release: () => {
          held.delete(url)
          for (const respond of hold.waiting) respond()
        },
      }
    },
    requested: () => [...requested],
    posted: () => [...posted],
    lookups: () => [...lookups],
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
