// The core reports through the protocol and through the log function it is given.
// This file must stay clean.

type Log = (line: string) => void
type Send = (message: { kind: 'protocol-error'; reason: 'malformed'; detail: string }) => void

export const reportMalformed = (send: Send, log: Log, detail: string) => {
  log(`could not read a client message: ${detail}`)
  send({ kind: 'protocol-error', reason: 'malformed', detail })
}

// The rest of `process` is not an output stream, and neither is a `stdout` on something else.
export const platform = process.platform
export const outputOf = (child: { stdout: string; stderr: string }) => child.stdout + child.stderr
