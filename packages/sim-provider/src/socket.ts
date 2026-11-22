// Where the sim provider listens. Node's `net` and the core's client (crates/sim-client) both
// take one string: a unix socket's path on Linux and macOS, a named pipe's name on Windows.

import { createHash } from 'node:crypto'
import { platform } from 'node:process'

/**
 * The pipe carries the simulator only, for dev and checks. Gmail mode never opens it.
 *
 * The provider's address for the socket file `path`: `path` itself, or on Windows a named pipe
 * whose name comes from `path`, so one folder keeps one pipe and two folders rarely share one.
 * Pass the result to `startSimProvider` and to core-sim's `--sim`.
 */
export function localSocket(path: string): string {
  if (platform !== 'win32') return path
  return `\\\\.\\pipe\\letterbox-${createHash('sha256').update(path).digest('hex').slice(0, 16)}`
}

/** Whether `address` is a named pipe, which leaves no file behind to remove. */
export const isPipe = (address: string) => address.startsWith('\\\\.\\pipe\\')
