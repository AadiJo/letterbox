// The typed client for the core, shared by every UI and by the test harness. It speaks
// only the protocol in @letterbox/protocol and reaches the core through a Transport:
// a WebSocket to a host process (websocket.ts) in the desktop renderer, the native bridge
// in the mobile app, a child process in packages/harness.
//
// It runs in a browser renderer and in Hermes, so it imports no Node module and reads no
// Node global. .oxlintrc.json enforces that for this package.
//
// No wait here has a time limit. A UI waits as long as the core takes, for example for a
// change made offline to settle. The harness adds its own limit around each wait.
//
// Every wait is registered before its message is sent, so a transport that answers
// synchronously, inside `send`, cannot answer before anyone listens.

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

export type Options = {
  /**
   * Makes the id for a subscription, a request or a change. Change ids must differ across
   * app restarts too: the core keeps every change, and treats a repeated change id as the
   * same change (protocol guarantee 4). Use `crypto.randomUUID` or similar in an app.
   */
  newId(kind: 'sub' | 'req' | 'change'): string
  /**
   * What happens to a core message no wait takes, such as a `settled` nobody awaits or an
   * `open-url`. A function receives it and nothing is held, as an app needs. 'keep' holds
   * it for a later `take` or `settled`, as a test needs.
   */
  unclaimed: 'keep' | ((message: CoreMessage) => void)
}

export type Subscription<V extends View> = {
  /** The newest data, or undefined before the first update. */
  latest(): Queries[V]['result'] | undefined
  /** The store revision of the newest update, or -1 before the first. */
  rev(): Rev
  /** How many updates have arrived. */
  count(): number
  /** Resolves with the next update that arrives after this call. Rejects once the subscription is closed or the core is gone. */
  next(): Promise<Queries[V]['result']>
  /**
   * Calls `listener` after each update, once `latest` holds it, until the returned function
   * runs or the subscription closes. For a UI store, such as React's useSyncExternalStore.
   */
  watch(listener: () => void): () => void
  /** Stops the view. Waiting `next` calls reject. */
  close(): void
}

/** The client an app uses. Messages no wait takes go to the `unclaimed` function. */
export type Client = {
  /** Says hello with this client's protocol version and resolves with the welcome. */
  hello(): Promise<Of<'welcome'>>
  /**
   * Opens a live view. The core sends an update now and on every change to its data. Once the
   * core is gone, opening or closing a view sends nothing and does not throw.
   */
  subscribe<V extends View>(query: QueryFor<V>): Subscription<V>
  /** Asks once: subscribes, takes the first update and unsubscribes. */
  query<V extends View>(query: QueryFor<V>): Promise<Queries[V]['result']>
  /** Sends a command and resolves with the core's first answer to it. Without `change`, `newId` names the change. */
  command(command: Command, change?: ChangeId): Promise<Of<'accepted'> | Of<'rejected'>>
  request<M extends Method>(request: RequestFor<M>): Promise<ResponseFor<M>>
  /** Starts a request without waiting, for a caller that needs its id or two requests in flight. */
  begin<M extends Method>(request: RequestFor<M>): { id: RequestId; done: Promise<ResponseFor<M>> }
}

/**
 * The client a test uses. It holds every message no wait has taken, so a wait made after
 * its message arrived still finds it. An app has no such waits, so it holds nothing.
 */
export type KeepingClient = Client & {
  /** Resolves with the `settled` for a change, whether it arrived already or arrives later. */
  settled(change: ChangeId): Promise<Of<'settled'>>
  /** Resolves with the next message of this kind that no other wait has taken. */
  take<Kind extends CoreMessage['kind']>(kind: Kind): Promise<Of<Kind>>
}

type Waiter = {
  matches: (message: CoreMessage) => boolean
  resolve: (message: CoreMessage) => void
  reject: (error: Error) => void
}

type Open = {
  latest: Of<'update'> | undefined
  count: number
  closed: boolean
  waiting: { resolve: (update: Of<'update'>) => void; reject: (error: Error) => void }[]
  watchers: Set<() => void>
}

/** Builds a client over `transport`. */
export function createClient(transport: Transport, options: Options & { unclaimed: 'keep' }): KeepingClient
export function createClient(transport: Transport, options: Options): Client
export function createClient(transport: Transport, options: Options): KeepingClient {
  /** Held messages no wait has taken yet, with `unclaimed: 'keep'`. */
  const unclaimed: CoreMessage[] = []
  const waiters: Waiter[] = []
  const subscriptions = new Map<SubscriptionId, Open>()
  let ended: Error | null = null

  transport.listen({
    receive: (message) => {
      if (message.kind === 'update') {
        // An update can arrive after its subscription closed, because the core had sent it
        // before it read the unsubscribe. Both orders are valid, so it is dropped.
        const open = subscriptions.get(message.sub)
        if (!open) return false
        open.latest = message
        open.count += 1
        for (const waiting of open.waiting.splice(0)) waiting.resolve(message)
        for (const watcher of open.watchers) watcher()
        return true
      }
      const index = waiters.findIndex((waiter) => waiter.matches(message))
      if (index !== -1) waiters.splice(index, 1)[0]?.resolve(message)
      else if (options.unclaimed === 'keep') unclaimed.push(message)
      else options.unclaimed(message)
      return true
    },
    end: (error) => {
      ended = error
      for (const waiter of waiters.splice(0)) waiter.reject(error)
      for (const open of subscriptions.values()) for (const waiting of open.waiting.splice(0)) waiting.reject(error)
    },
  })

  /** Waits for a message that passes `matches`, taking a held one first. Register it before sending. */
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

  /**
   * Waits for the answer to `message`, then sends it. If `send` throws, the wait is dropped
   * and the returned promise rejects with that error, so nothing rejects later unseen.
   */
  const ask = <Message extends CoreMessage>(
    message: ClientMessage,
    matches: (message: CoreMessage) => message is Message,
  ) => {
    const answer = waitFor(matches)
    try {
      transport.send(message)
    } catch (error) {
      const index = waiters.findIndex((waiter) => waiter.matches === matches)
      if (index !== -1) waiters.splice(index, 1)
      // The dropped wait may already have rejected because the core ended. Nobody holds it now.
      answer.catch(() => {})
      return Promise.reject<Message>(error)
    }
    return answer
  }

  const take: KeepingClient['take'] = (kind) => waitFor((message): message is Of<typeof kind> => message.kind === kind)

  /**
   * Opens a live view. Once the core is gone, opening and closing one send nothing and never
   * throw, so a UI can keep mounting and unmounting views: a view opened then has no data,
   * and its `next` rejects with why the core ended.
   */
  const subscribe = <V extends View>(query: QueryFor<V>): Subscription<V> => {
    const sub = options.newId('sub') as SubscriptionId
    const open: Open = { latest: undefined, count: 0, closed: false, waiting: [], watchers: new Set() }
    subscriptions.set(sub, open)
    if (!ended) transport.send({ kind: 'subscribe', sub, query })
    // Updates on this subscription carry the data for the view it asked for.
    const dataOf = (update: Of<'update'>) => update.data as Queries[V]['result']
    return {
      latest: () => (open.latest ? dataOf(open.latest) : undefined),
      rev: () => open.latest?.rev ?? -1,
      count: () => open.count,
      next: () =>
        new Promise((resolve, reject) => {
          if (ended) return reject(ended)
          if (open.closed) return reject(new Error(`the subscription to ${query.view} is closed`))
          open.waiting.push({ resolve: (update) => resolve(dataOf(update)), reject })
        }),
      watch: (listener) => {
        // A fresh function per call, so the same listener can watch twice and stop each once.
        const watcher = () => listener()
        if (!open.closed) open.watchers.add(watcher)
        return () => void open.watchers.delete(watcher)
      },
      close: () => {
        if (open.closed) return
        open.closed = true
        open.watchers.clear()
        subscriptions.delete(sub)
        const error = new Error(`the subscription to ${query.view} was closed`)
        for (const waiting of open.waiting.splice(0)) waiting.reject(error)
        // The core forgot every subscription when it ended.
        if (!ended) transport.send({ kind: 'unsubscribe', sub })
      },
    }
  }

  const begin: Client['begin'] = (request) => {
    const id = options.newId('req') as RequestId
    const done = ask(
      { kind: 'request', id, request },
      (message): message is Of<'response'> => message.kind === 'response' && message.id === id,
    )
    // The core answers a request with the response for the same method.
    return { id, done: done as Promise<Of<'response'> & ResponseFor<typeof request.method>> }
  }

  return {
    hello: () =>
      ask({ kind: 'hello', protocol: PROTOCOL }, (message): message is Of<'welcome'> => message.kind === 'welcome'),
    subscribe,
    query: async (query) => {
      const subscription = subscribe(query)
      const data = subscription.latest() ?? (await subscription.next())
      subscription.close()
      return data
    },
    command: (command, change = options.newId('change') as ChangeId) =>
      ask(
        { kind: 'command', change, command },
        (message): message is Of<'accepted'> | Of<'rejected'> =>
          (message.kind === 'accepted' || message.kind === 'rejected') && message.change === change,
      ),
    settled: (change) =>
      waitFor((message): message is Of<'settled'> => message.kind === 'settled' && message.change === change),
    request: (request) => begin(request).done,
    begin,
    take,
  }
}
