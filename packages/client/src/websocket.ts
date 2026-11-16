// A Transport over a WebSocket, for a UI that reaches the core through a host process:
// packages/dev-host in the browser dev loop. Each frame, both ways, is one protocol
// message as the JSON line core-sim reads and writes.
//
// It uses only the WebSocket global, which browsers and React Native both have.

import type { CoreMessage } from '@letterbox/protocol'
import type { Listener, Transport } from './client.ts'

/**
 * Connects to `url` at once. Messages sent before the socket opens wait, and go in order
 * once it does. When the socket closes, the client's waits reject with the close reason.
 */
export function webSocketTransport(url: string): Transport {
  const socket = new WebSocket(url)
  const unsent: string[] = []
  let listener: Listener | undefined
  let ended = false

  const end = (reason: string) => {
    if (ended) return
    ended = true
    listener?.end(new Error(reason))
    socket.close()
  }

  socket.addEventListener('open', () => {
    for (const line of unsent.splice(0)) socket.send(line)
  })
  socket.addEventListener('message', (event) => {
    if (ended) return
    if (typeof event.data !== 'string') return end('the core sent a frame that is not text')
    let message: CoreMessage
    try {
      // The host relays the core's own lines unchanged. The scenarios check every message
      // the core sends against the protocol, so the client takes them as they come.
      message = JSON.parse(event.data)
    } catch {
      return end(`the core sent a frame that is not JSON: ${event.data}`)
    }
    listener?.receive(message)
  })
  // A failed connect or a dropped socket shows up as an error and then a close. Only the close matters.
  socket.addEventListener('close', (event) =>
    end(`the connection to the core closed (${event.code}${event.reason ? `: ${event.reason}` : ''})`),
  )

  return {
    send: (message) => {
      if (ended) throw new Error('the connection to the core is closed')
      const line = JSON.stringify(message)
      if (socket.readyState === WebSocket.OPEN) socket.send(line)
      else unsent.push(line)
    },
    listen: (given) => {
      listener = given
    },
  }
}
