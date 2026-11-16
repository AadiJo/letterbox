// The dev host's port. It comes from the worktree's path, so one worktree keeps its port
// across restarts and two worktrees rarely share one. When it is taken, the next free one is used.

import { createHash } from 'node:crypto'
import type { Server } from 'node:http'

/** Below Linux's ephemeral range (32768 and up), so outgoing connections rarely hold it. */
const FIRST = 20_000
const COUNT = 10_000
/** How many ports after the first one `listen` tries. */
const TRIES = 50

/** A port in 20000..29999 that depends only on `worktree`, the repo root's absolute path. */
export function portFor(worktree: string): number {
  const digest = createHash('sha256').update(worktree).digest()
  return FIRST + (digest.readUInt32BE(0) % COUNT)
}

/** Listens on 127.0.0.1 at `port`, or the next free port after it. Port 0 lets the system pick. Resolves with the port. */
export async function listen(server: Server, port: number, tries = TRIES): Promise<number> {
  const bound = await new Promise<number | 'taken'>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => (error.code === 'EADDRINUSE' ? resolve('taken') : reject(error))
    server.once('error', onError)
    server.listen(port, '127.0.0.1', () => {
      server.off('error', onError)
      const address = server.address()
      resolve(typeof address === 'object' && address !== null ? address.port : port)
    })
  })
  if (bound !== 'taken') return bound
  if (port === 0 || tries <= 1)
    throw new Error(`port ${port} and the ports after it are taken. Pass --port to pick another.`)
  return listen(server, port + 1, tries - 1)
}
