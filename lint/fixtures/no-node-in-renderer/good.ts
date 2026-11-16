// The renderer reaches the core through @letterbox/client and uses what browsers have.
// This file must stay clean.

import { createClient } from '@letterbox/client'
import { webSocketTransport } from '@letterbox/client/websocket'

export const connect = () =>
  createClient(webSocketTransport(new URL('/core', location.href).href), {
    newId: (kind) => `${kind}-${crypto.getRandomValues(new Uint32Array(1))[0]}`,
    unclaimed: () => {},
  })

// A local of the same name is not Node's global, and neither is a property of something else.
export const describe = (process: { name: string }) => process.name
export const later = (run: () => void) => setTimeout(run, 0)
export const pathOf = (url: URL) => url.pathname
