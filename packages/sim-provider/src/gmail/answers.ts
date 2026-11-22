// Answers that go wrong on their way back, for scenarios about what the core makes of them:
// one damaged as a connection or a server can damage it (`damaged`), and one that stalls
// halfway (`stall`). server.ts uses both.

import type { ServerResponse } from 'node:http'
import type { AnswerDamage } from '../contract.ts'

/**
 * A 200 that goes wrong on its way back. The status line and headers promise the whole body,
 * then the connection ends before any of it, or halfway through it, or the body arrives
 * whole but is not JSON.
 */
export const damaged = (response: ServerResponse, body: string, how: AnswerDamage): void => {
  const sent = how === 'invalid-json' ? '{"id": ' : body
  response.writeHead(200, {
    'Content-Type': 'application/json; charset=UTF-8',
    'Content-Length': String(Buffer.byteLength(sent)),
  })
  if (how === 'invalid-json') return void response.end(sent)
  // Write what goes, then end the connection with the rest of the body still owed.
  if (how === 'truncated')
    return void response.write(sent.slice(0, Math.floor(sent.length / 2)), () => response.socket?.end())
  response.flushHeaders()
  response.socket?.end()
}

/**
 * Makes the answer about to be written to `response` stall halfway: `end` writes the status
 * line and the first half of the body, chunked so the client waits for the rest, and never
 * finishes, though with `trickle` a space follows every half second. `stalled` runs once that
 * half is written. The fake's close destroys the socket.
 */
export const stall = (response: ServerResponse, trickle: boolean, stalled: () => void): void => {
  response.end = ((chunk?: unknown) => {
    const body = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString() : ''
    response.write(body.slice(0, Math.floor(body.length / 2)), stalled)
    if (trickle) {
      const drip = setInterval(() => response.write(' '), 500)
      response.on('close', () => clearInterval(drip))
    }
    return response
  }) as ServerResponse['end']
}
