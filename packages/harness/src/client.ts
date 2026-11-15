// A client for the core process, as a scenario uses it. It speaks only the
// protocol, so it would drive a core written in any language the same way.

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import type {
  ChangeId,
  ClientMessage,
  Command,
  CoreMessage,
  Queries,
  Query,
  Request,
  RequestId,
  Requests,
  Response,
  Rev,
  SubscriptionId,
} from '@letterbox/protocol'
import { PROTOCOL } from '@letterbox/protocol'
import { coreMessageProblem } from '@letterbox/protocol/parse'

/** One line of a scenario's transcript. */
export type TranscriptEntry =
  | { from: 'ui'; message: unknown }
  | { from: 'core'; message: CoreMessage }
  | { from: 'provider'; did: string; with: unknown[] }
  | { from: 'scenario'; note: string }

type Of<Kind extends CoreMessage['kind']> = Extract<CoreMessage, { kind: Kind }>
type View = keyof Queries
type Method = keyof Requests

export type Subscription<V extends View> = {
  /** The newest data, or undefined before the first update. */
  latest(): Queries[V]['result'] | undefined
  /** The store revision of the newest update. */
  rev(): Rev
  /** How many updates have arrived. */
  count(): number
  /** Resolves with the next update that arrives after this call. */
  next(): Promise<Queries[V]['result']>
  close(): void
}

export type CoreClient = {
  hello(): Promise<Of<'welcome'>>
  subscribe<V extends View>(query: Extract<Query, { view: V }>): Subscription<V>
  /** Asks once: subscribes, takes the first update and unsubscribes. */
  query<V extends View>(query: Extract<Query, { view: V }>): Promise<Queries[V]['result']>
  /** Sends a command and resolves with the core's first answer to it. */
  command(command: Command, change?: ChangeId): Promise<Of<'accepted'> | Of<'rejected'>>
  /** Resolves with the `settled` for a change. */
  settled(change: ChangeId): Promise<Of<'settled'>>
  request<M extends Method>(request: Extract<Request, { method: M }>): Promise<Extract<Response, { method: M }>>
  /** Starts a request without waiting, for scenarios that need two in flight. */
  begin<M extends Method>(
    request: Extract<Request, { method: M }>,
  ): { id: RequestId; done: Promise<Extract<Response, { method: M }>> }
  /** Resolves with the next message of this kind that no one has taken yet. */
  take<Kind extends CoreMessage['kind']>(kind: Kind): Promise<Of<Kind>>
  /** Sends anything at all, for scenarios about bad input. */
  sendRaw(value: unknown): void
  /** Closes the core's input and waits for the process to end. */
  stop(): Promise<void>
  /** Every message the core sent that broke the protocol's shapes. A scenario fails if there is one. */
  violations(): string[]
}

const CORE_MAIN = fileURLToPath(new URL('./core-main.ts', import.meta.url))
const WAIT_MS = 5000

/** Starts a core process over `dataDir` that reaches the sim provider at `socketPath`. */
export function startCore(dataDir: string, socketPath: string, record: (entry: TranscriptEntry) => void): CoreClient {
  const child = spawn(process.execPath, [CORE_MAIN, '--data', dataDir, '--sim', socketPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))

  const unclaimed: CoreMessage[] = []
  const waiters: {
    matches: (message: CoreMessage) => boolean
    resolve: (message: CoreMessage) => void
    reject: (error: Error) => void
  }[] = []
  const subscriptions = new Map<SubscriptionId, { updates: Of<'update'>[]; onUpdate: (() => void)[] }>()
  let ended: Error | null = null
  let counter = 0
  const violations: string[] = []

  const fail = (error: Error) => {
    ended = error
    for (const waiter of waiters.splice(0)) waiter.reject(error)
  }

  /** Handles one line from the core: checks it against the protocol, records it, and hands it on. */
  const handle = (line: string) => {
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      value = undefined
    }
    const problem = value === undefined ? 'it is not JSON' : coreMessageProblem(value)
    if (problem !== null) {
      const violation = `the core sent a message outside the protocol (${problem}): ${line}`
      violations.push(violation)
      record({ from: 'scenario', note: violation })
      return fail(new Error(violation))
    }
    // coreMessageProblem accepted every field, so this value is a CoreMessage.
    const message = value as CoreMessage
    if (message.kind === 'update') {
      // An update for a subscription this client already closed is dropped without a record.
      // Whether one arrives depends on timing between the two processes, and both orders are valid.
      const subscription = subscriptions.get(message.sub)
      if (!subscription) return
      record({ from: 'core', message })
      subscription.updates.push(message)
      for (const notify of subscription.onUpdate.splice(0)) notify()
      return
    }
    record({ from: 'core', message })
    const index = waiters.findIndex((waiter) => waiter.matches(message))
    if (index === -1) unclaimed.push(message)
    else waiters.splice(index, 1)[0]?.resolve(message)
  }

  // Lines are handled one per turn of the event loop. The scenario code that was
  // waiting for a line then runs before the next line is recorded, however the
  // lines happened to arrive. That keeps a transcript the same from run to run.
  const arrived: string[] = []
  let draining = false
  const drain = () => {
    const line = arrived.shift()
    if (line === undefined) return void (draining = false)
    handle(line)
    setImmediate(drain)
  }
  createInterface({ input: child.stdout }).on('line', (line) => {
    arrived.push(line)
    if (draining) return
    draining = true
    setImmediate(drain)
  })
  const exited = new Promise<void>((resolve) => {
    child.on('exit', (code) => {
      const finish = () => {
        if (draining) return void setImmediate(finish)
        fail(new Error(`the core exited with code ${code}. stderr:\n${stderr}`))
        resolve()
      }
      finish()
    })
  })

  const send = (message: ClientMessage) => sendRaw(message)
  const sendRaw = (value: unknown) => {
    record({ from: 'ui', message: value })
    child.stdin.write(`${typeof value === 'string' ? value : JSON.stringify(value)}\n`)
  }

  /** Waits for a message that passes `matches`, taking an unclaimed one first. */
  const waitFor = <Message extends CoreMessage>(what: string, matches: (message: CoreMessage) => message is Message) =>
    new Promise<Message>((resolve, reject) => {
      const index = unclaimed.findIndex(matches)
      const found = index === -1 ? undefined : unclaimed.splice(index, 1)[0]
      if (found && matches(found)) return resolve(found)
      if (ended) return reject(ended)
      const timer = setTimeout(() => {
        const at = waiters.indexOf(waiter)
        if (at !== -1) waiters.splice(at, 1)
        reject(new Error(`timed out after ${WAIT_MS} ms waiting for ${what}`))
      }, WAIT_MS)
      const waiter = {
        matches,
        resolve: (message: CoreMessage) => {
          clearTimeout(timer)
          if (matches(message)) resolve(message)
        },
        reject: (error: Error) => {
          clearTimeout(timer)
          reject(error)
        },
      }
      waiters.push(waiter)
    })

  const take: CoreClient['take'] = (kind) =>
    waitFor(
      `a ${kind} message`,
      (message): message is Extract<CoreMessage, { kind: typeof kind }> => message.kind === kind,
    )

  const subscribe = <V extends View>(query: Extract<Query, { view: V }>): Subscription<V> => {
    const sub = `sub_${++counter}` as SubscriptionId
    const state: { updates: Of<'update'>[]; onUpdate: (() => void)[] } = { updates: [], onUpdate: [] }
    subscriptions.set(sub, state)
    send({ kind: 'subscribe', sub, query })
    // Updates on this subscription carry the data for the view it asked for.
    const dataOf = (update: Of<'update'>) => update.data as Queries[V]['result']
    return {
      latest: () => {
        const last = state.updates.at(-1)
        return last ? dataOf(last) : undefined
      },
      rev: () => state.updates.at(-1)?.rev ?? -1,
      count: () => state.updates.length,
      next: () =>
        new Promise((resolve, reject) => {
          const before = state.updates.length
          const timer = setTimeout(() => reject(new Error(`timed out waiting for an update to ${query.view}`)), WAIT_MS)
          state.onUpdate.push(() => {
            clearTimeout(timer)
            const update = state.updates[before]
            if (update) resolve(dataOf(update))
          })
        }),
      close: () => {
        subscriptions.delete(sub)
        send({ kind: 'unsubscribe', sub })
      },
    }
  }

  const begin: CoreClient['begin'] = (request) => {
    const id = `req_${++counter}` as RequestId
    send({ kind: 'request', id, request })
    const done = waitFor(
      `the response to ${request.method}`,
      (message): message is Of<'response'> => message.kind === 'response' && message.id === id,
    )
    // The core answers a request with the response for the same method.
    return { id, done: done as Promise<Of<'response'> & Extract<Response, { method: typeof request.method }>> }
  }

  return {
    hello: () => {
      send({ kind: 'hello', protocol: PROTOCOL })
      return take('welcome')
    },
    subscribe,
    query: async (query) => {
      const subscription = subscribe(query)
      const data = subscription.latest() ?? (await subscription.next())
      subscription.close()
      return data
    },
    command: (command, change = `change_${++counter}` as ChangeId) => {
      send({ kind: 'command', change, command })
      return waitFor(
        `an answer to ${command.kind}`,
        (message): message is Of<'accepted'> | Of<'rejected'> =>
          (message.kind === 'accepted' || message.kind === 'rejected') && message.change === change,
      )
    },
    settled: (change) =>
      waitFor(
        `settled for ${change}`,
        (message): message is Of<'settled'> => message.kind === 'settled' && message.change === change,
      ),
    request: (request) => begin(request).done,
    begin,
    take,
    sendRaw,
    violations: () => [...violations],
    stop: async () => {
      child.stdin.end()
      await exited
    },
  }
}
