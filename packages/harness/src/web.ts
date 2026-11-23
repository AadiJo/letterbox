// The fake web every scenario's core fetches remote images from. core-sim's `--web` sends each
// image request here over plain http, `https://host/path?q` as `/host/path?q` (see HttpsWeb in
// crates/host/src/web.rs). A scenario says what each URL answers and reads back every URL the
// core asked for, so it can show that a tracker, or a URL the core never listed, was never fetched.

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
  /** Every URL the core asked for, as https URLs, in the order the requests came. */
  requested(): string[]
  close(): Promise<void>
}

/** Starts the fake web on a free port of 127.0.0.1. */
export async function startFakeWeb(): Promise<FakeWeb> {
  const answers = new Map<string, WebAnswer>()
  const requested: string[] = []
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = `https:/${request.url ?? '/'}`
    requested.push(url)
    // The core must send nothing that identifies the reader or the page.
    const leaks = ['cookie', 'referer', 'authorization'].filter((name) => request.headers[name] !== undefined)
    if (leaks.length > 0) {
      response.writeHead(400).end(`sent ${leaks.join(', ')}`)
      return
    }
    const answer = answers.get(url) ?? { kind: 'status', status: 404 }
    if (answer.kind === 'body') response.writeHead(200, { 'content-type': answer.mime }).end(answer.bytes)
    else if (answer.kind === 'redirect') response.writeHead(302, { location: answer.location }).end()
    else response.writeHead(answer.status).end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('the fake web listens on a TCP port')
  return {
    url: `http://127.0.0.1:${address.port}`,
    serve: (url, answer) => void answers.set(url, answer),
    requested: () => [...requested],
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
