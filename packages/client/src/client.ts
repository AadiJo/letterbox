// The typed client for the core, shared by every UI and by the test harness. It speaks
// only the protocol in @letterbox/protocol and reaches the core through a Transport:
// IPC in the desktop renderer, the native bridge in the mobile app, a child process in
// packages/harness.
//
// It runs in a browser renderer and in Hermes, so it imports no Node module and reads no
// Node global. .oxlintrc.json enforces that for this package.
//
// No wait here has a time limit. A UI waits as long as the core takes, for example for a
// change made offline to settle. The harness adds its own limit around each wait.

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

/** The core message of one kind. */
export type Of<Kind extends CoreMessage['kind']> = Extract<CoreMessage, { kind: Kind }>
type View = keyof Queries
type Method = keyof Requests
type QueryFor<V extends View> = Extract<Query, { view: V }>
type RequestFor<M extends Method> = Extract<Request, { method: M }>
type ResponseFor<M extends Method> = Extract<Response, { method: M }>

/**
 * How the client reaches one core. `createClient` calls `listen` once, before it sends
 * anything. The transport then hands the listener every core message, in the order the
 * core sent it, and calls `end` once if the core goes away.
 */
export type Transport = {
  send(message: ClientMessage): void
  listen(listener: Listener): void
}

export type Listener = {
  /** Takes one core message. Returns false when the client dropped it: an update for a subscription it already closed. */
  receive(message: CoreMessage): boolean
  /** The core is gone. Every wait still open rejects with `error`, and so does every later one. */
  end(error: Error): void
}

export type Subscription<V extends View> = {
  /** The newest data, or undefined before the first update. */
  latest(): Queries[V]['result'] | undefined
  /** The store revision of the newest update, or -1 before the first. */
  rev(): Rev
  /** How many updates have arrived. */
  count(): number
  /** Resolves with the next update that arrives after this call. */
  next(): Promise<Queries[V]['result']>
  close(): void
}

export type Client = {
  /** Says hello with this client's protocol version and resolves with the welcome. */
  hello(): Promise<Of<'welcome'>>
  /** Opens a live view. The core sends an update now and on every change to its data. */
  subscribe<V extends View>(query: QueryFor<V>): Subscription<V>
  /** Asks once: subscribes, takes the first update and unsubscribes. */
  query<V extends View>(query: QueryFor<V>): Promise<Queries[V]['result']>
  /** Sends a command and resolves with the core's first answer to it. Without `change`, the client names the change. */
  command(command: Command, change?: ChangeId): Promise<Of<'accepted'> | Of<'rejected'>>
  /** Resolves with the `settled` for a change, whenever the provider has it. */
  settled(change: ChangeId): Promise<Of<'settled'>>
  request<M extends Method>(request: RequestFor<M>): Promise<ResponseFor<M>>
  /** Starts a request without waiting, for a caller that needs its id or two requests in flight. */
  begin<M extends Method>(request: RequestFor<M>): { id: RequestId; done: Promise<ResponseFor<M>> }
  /** Resolves with the next message of this kind that no other wait has taken. */
  take<Kind extends CoreMessage['kind']>(kind: Kind): Promise<Of<Kind>>
}

type Waiter = {
  matches: (message: CoreMessage) => boolean
  resolve: (message: CoreMessage) => void
  reject: (error: Error) => void
}

type Open = {
  updates: Of<'update'>[]
  waiting: { notify: () => void; reject: (error: Error) => void }[]
}

/** Builds a client over `transport`. */
export function createClient(transport: Transport): Client {
  /** Messages no wait has taken yet. The next wait that matches one takes it. */
  const unclaimed: CoreMessage[] = []
  const waiters: Waiter[] = []
  const subscriptions = new Map<SubscriptionId, Open>()
  let ended: Error | null = null
  let counter = 0

  transport.listen({
    receive: (message) => {
      if (message.kind === 'update') {
        // An update can arrive after its subscription closed, because the core had sent it
        // before it read the unsubscribe. Both orders are valid, so it is dropped.
        const open = subscriptions.get(message.sub)
        if (!open) return false
        open.updates.push(message)
        for (const waiting of open.waiting.splice(0)) waiting.notify()
        return true
      }
      const index = waiters.findIndex((waiter) => waiter.matches(message))
      if (index === -1) unclaimed.push(message)
      else waiters.splice(index, 1)[0]?.resolve(message)
      return true
    },
    end: (error) => {
      ended = error
      for (const waiter of waiters.splice(0)) waiter.reject(error)
      for (const open of subscriptions.values()) for (const waiting of open.waiting.splice(0)) waiting.reject(error)
    },
  })

  /** Waits for a message that passes `matches`, taking an unclaimed one first. */
  const waitFor = <Message extends CoreMessage>(matches: (message: CoreMessage) => message is Message) =>
    new Promise<Message>((resolve, reject) => {
      const index = unclaimed.findIndex(matches)
      const found = index === -1 ? undefined : unclaimed.splice(index, 1)[0]
      if (found && matches(found)) return resolve(found)
      if (ended) return reject(ended)
      waiters.push({
        matches,
        resolve: (message) => {
          if (matches(message)) resolve(message)
        },
        reject,
      })
    })

  const take: Client['take'] = (kind) => waitFor((message): message is Of<typeof kind> => message.kind === kind)

  const subscribe = <V extends View>(query: QueryFor<V>): Subscription<V> => {
    const sub = `sub_${++counter}` as SubscriptionId
    const open: Open = { updates: [], waiting: [] }
    subscriptions.set(sub, open)
    transport.send({ kind: 'subscribe', sub, query })
    // Updates on this subscription carry the data for the view it asked for.
    const dataOf = (update: Of<'update'>) => update.data as Queries[V]['result']
    return {
      latest: () => {
        const last = open.updates.at(-1)
        return last ? dataOf(last) : undefined
      },
      rev: () => open.updates.at(-1)?.rev ?? -1,
      count: () => open.updates.length,
      next: () =>
        new Promise((resolve, reject) => {
          if (ended) return reject(ended)
          const before = open.updates.length
          open.waiting.push({
            notify: () => {
              const update = open.updates[before]
              if (update) resolve(dataOf(update))
            },
            reject,
          })
        }),
      close: () => {
        subscriptions.delete(sub)
        transport.send({ kind: 'unsubscribe', sub })
      },
    }
  }

  const begin: Client['begin'] = (request) => {
    const id = `req_${++counter}` as RequestId
    transport.send({ kind: 'request', id, request })
    const done = waitFor((message): message is Of<'response'> => message.kind === 'response' && message.id === id)
    // The core answers a request with the response for the same method.
    return { id, done: done as Promise<Of<'response'> & ResponseFor<typeof request.method>> }
  }

  return {
    hello: () => {
      transport.send({ kind: 'hello', protocol: PROTOCOL })
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
      transport.send({ kind: 'command', change, command })
      return waitFor(
        (message): message is Of<'accepted'> | Of<'rejected'> =>
          (message.kind === 'accepted' || message.kind === 'rejected') && message.change === change,
      )
    },
    settled: (change) =>
      waitFor((message): message is Of<'settled'> => message.kind === 'settled' && message.change === change),
    request: (request) => begin(request).done,
    begin,
    take,
  }
}
