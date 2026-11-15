// The core: one object that takes client messages and sends core messages.
// It owns the store, runs sync through the adapters, and keeps every
// subscription up to date. It never touches stdin, stdout or a socket. The
// program that creates it decides how messages travel.
//
// Order is what makes the protocol's guarantees hold:
//   - Every change to the world happens inside `commit`, which writes the
//     store, then sends updates to every subscription whose answer changed.
//   - `accepted`, `settled` and `response` are sent after the commit they
//     describe, so a client that has one has already seen its effects.
//   - Work for one account runs in a queue, one task at a time, so changes
//     reach the provider in the order the user made them.

import {
  type AccountId,
  type AccountStatus,
  type ChangeId,
  type Command,
  type CoreMessage,
  type MessageId,
  PROTOCOL,
  type Query,
  type Refusal,
  type Request,
  type RequestId,
  type Rev,
  type SignInOptionId,
  type SubscriptionId,
} from '@letterbox/protocol'
import { parseClientMessage } from '@letterbox/protocol/parse'
import type { Adapter, AdapterFactory, AdapterFailure, PageToken, RemoteMessage } from './adapter.ts'
import { overlay, plan, resolve, targets } from './changes.ts'
import type { Environment } from './clock.ts'
import { reconcile } from './reconcile.ts'
import { openStore } from './store.ts'
import { evaluate, type Live } from './views.ts'
import {
  type AccountRecord,
  type ChangeRecord,
  type ChangeResult,
  type Records,
  type Transaction,
  loadWorld,
  messagesOf,
  putAccount,
  putChange,
  putMessage,
  putThread,
  removeAccount,
  removeChange,
  removeMailbox,
  removeMessage,
  removeThread,
} from './world.ts'

export type CoreOptions = {
  /** The folder that holds the store. */
  dataPath: string
  env: Environment
  /** One per way to add an account. */
  factories: AdapterFactory[]
  send(message: CoreMessage): void
  /** Diagnostics for a person debugging the core. Never part of the protocol. */
  log(line: string): void
}

export type Core = {
  /** Takes one decoded message from the client. Anything that is not a valid message is answered with a protocol-error. */
  receive(value: unknown): void
  /** Lets work in flight finish, then releases adapters and the store. */
  close(): Promise<void>
}

type PassResult = 'ok' | AdapterFailure

export function createCore(options: CoreOptions): Core {
  const { env, send, log } = options
  const store = openStore<Records>(options.dataPath)
  const world = loadWorld(store)
  const factories = new Map(options.factories.map((factory) => [factory.option.id, factory]))

  const adapters = new Map<AccountId, Adapter>()
  for (const account of world.accounts.values()) {
    const factory = factories.get(account.factoryId)
    if (factory && account.session !== '') adapters.set(account.id, factory.resume(account.session))
  }

  const subscriptions = new Map<SubscriptionId, { query: Query; sent: string }>()
  const syncing = new Set<AccountId>()
  const loadingBodies = new Set<MessageId>()
  const unreachableBodies = new Set<MessageId>()
  const queues = new Map<AccountId, Promise<unknown>>()
  const signIns = new Map<string, { controller: AbortController; superseded: boolean; answered: Promise<void> }>()

  const status = (account: AccountRecord): AccountStatus => {
    const starting: AccountStatus = { state: 'syncing', done: 0, total: null, lastSyncedAt: account.lastSyncedAt }
    if (syncing.has(account.id)) return starting
    switch (account.health) {
      case 'ok':
        return account.lastSyncedAt ? { state: 'idle', lastSyncedAt: account.lastSyncedAt } : starting
      case 'offline':
        return { state: 'offline', lastSyncedAt: account.lastSyncedAt }
      case 'needs-sign-in':
        return { state: 'needs-sign-in' }
      case 'provider-error':
        return { state: 'error', reason: 'provider', lastSyncedAt: account.lastSyncedAt }
    }
  }

  const live: Live = {
    status,
    missingBody: (record) =>
      unreachableBodies.has(record.id) || !adapters.has(record.accountId)
        ? { state: 'unavailable', reason: 'offline' }
        : { state: 'loading' },
    options: options.factories.map((factory) => ({
      id: factory.option.id as SignInOptionId,
      label: factory.option.label,
      method: factory.option.method,
    })),
  }

  /** Sends an update to every subscription whose answer changed, then starts loading bodies someone is looking at. */
  const flush = () => {
    const rev = store.rev()
    for (const [sub, entry] of subscriptions) {
      const update = evaluate(world, entry.query, live)
      const text = JSON.stringify(update.data)
      if (text === entry.sent) continue
      entry.sent = text
      send({ kind: 'update', sub, rev, ...update })
    }
    for (const { query } of subscriptions.values()) {
      if (query.view !== 'thread') continue
      for (const record of messagesOf(world, query.threadId)) {
        if (
          record.body ||
          loadingBodies.has(record.id) ||
          unreachableBodies.has(record.id) ||
          !adapters.has(record.accountId)
        )
          continue
        loadingBodies.add(record.id)
        background(record.accountId, () => fetchBody(record.id))
      }
    }
  }

  /**
   * The only way the world changes. `announce` runs after the write and before
   * the updates, which is where `accepted` goes.
   */
  const commit = (work: (tx: Transaction, rev: Rev) => void, announce?: (rev: Rev) => void): Rev => {
    const rev = store.write(work)
    announce?.(rev)
    flush()
    return rev
  }

  /** Runs `task` after everything already queued for this account. */
  const enqueue = <Result>(accountId: AccountId, task: () => Promise<Result>): Promise<Result> => {
    const run = (queues.get(accountId) ?? Promise.resolve()).then(task)
    queues.set(
      accountId,
      run.catch((error: unknown) => log(`a task for ${accountId} failed: ${String(error)}`)),
    )
    return run
  }

  /** Queues a task nobody waits for. A failure is logged by the queue. */
  const background = (accountId: AccountId, task: () => Promise<unknown>) =>
    void enqueue(accountId, task).catch(() => undefined)

  async function fetchBody(id: MessageId) {
    const record = world.messages.get(id)
    const adapter = record && adapters.get(record.accountId)
    if (!record || !adapter) return void loadingBodies.delete(id)
    const result = await adapter.body(record.ref)
    loadingBodies.delete(id)
    const current = world.messages.get(id)
    if (!current) return
    if (!result.ok) {
      unreachableBodies.add(id)
      return void commit(() => undefined)
    }
    const body = result.kind === 'body' ? { kind: 'body' as const, body: result.body } : { kind: 'gone' as const }
    commit((tx) => putMessage(world, tx, { ...current, body }, current))
  }

  const settle = (change: ChangeRecord, result: ChangeResult) => {
    const rev = commit((tx, at) => putChange(world, tx, { ...change, outcome: { rev: at, result } }))
    send({ kind: 'settled', change: change.id, rev, result })
  }

  /** Carries every pending change for one account to the provider, oldest first. Stops when the provider is unreachable. */
  async function push(accountId: AccountId, adapter: Adapter): Promise<PassResult> {
    const waiting = [...world.changes.values()].filter(
      (change) => change.accountId === accountId && change.outcome === null,
    )
    for (const change of waiting) {
      if (!change.op) continue
      const { exists, steps } = plan(world, change.op)
      if (!exists) {
        settle(change, { failed: 'unknown-target' })
        continue
      }
      let refused: Refusal | null = null
      for (const step of steps) {
        const outcome = await adapter.apply(step.mutation)
        if (!outcome.ok) return outcome.failure
        if (outcome.kind === 'refused') {
          refused = outcome.reason
          break
        }
        // The provider now holds this part of the change, so it becomes part of what the provider reported.
        commit((tx) => {
          for (const id of step.messageIds) {
            const record = world.messages.get(id)
            if (!record) continue
            const ref = outcome.moved.find((pair) => pair.from === record.ref)?.to ?? record.ref
            putMessage(world, tx, { ...record, ref, server: overlay(record.server, step.part, id) }, record)
          }
        })
      }
      settle(change, refused ? { failed: refused } : 'done')
    }
    return 'ok'
  }

  /** Fetches what changed at the provider. Falls back to a full snapshot when there is no cursor or it expired. */
  async function pull(accountId: AccountId, adapter: Adapter): Promise<PassResult> {
    const cursor = world.accounts.get(accountId)?.cursor
    if (cursor) {
      const result = await adapter.changes(cursor)
      if (!result.ok) return result.failure
      if (result.kind === 'changes') {
        commit((tx) => {
          const account = world.accounts.get(accountId)
          if (!account) return
          reconcile(world, tx, account, {
            full: false,
            mailboxes: result.mailboxes,
            added: result.added,
            updated: result.updated,
            removed: result.removed,
          })
          putAccount(world, tx, { ...account, cursor: result.cursor })
        })
        return 'ok'
      }
    }

    const messages: RemoteMessage[] = []
    let page: PageToken | null = null
    for (;;) {
      const result = await adapter.snapshot(page)
      if (!result.ok) return result.failure
      messages.push(...result.messages)
      if (result.next === null) {
        commit((tx) => {
          const account = world.accounts.get(accountId)
          if (!account) return
          reconcile(world, tx, account, {
            full: true,
            mailboxes: result.mailboxes,
            added: messages,
            updated: [],
            removed: [],
          })
          putAccount(world, tx, { ...account, cursor: result.cursor })
        })
        return 'ok'
      }
      page = result.next
    }
  }

  /** One sync pass: push what is pending, then pull when asked, then record how it went. */
  async function pass(accountId: AccountId, withPull: boolean): Promise<PassResult> {
    const adapter = adapters.get(accountId)
    if (!adapter || !world.accounts.has(accountId)) return 'ok'
    if (withPull) {
      syncing.add(accountId)
      commit(() => undefined)
    }
    let result = await push(accountId, adapter)
    if (result === 'ok' && withPull) result = await pull(accountId, adapter)
    syncing.delete(accountId)

    const account = world.accounts.get(accountId)
    if (!account) return result
    const synced = result === 'ok' && withPull
    if (synced) {
      for (const id of unreachableBodies)
        if (world.messages.get(id)?.accountId === accountId) unreachableBodies.delete(id)
    }
    if (withPull || result !== account.health) {
      commit((tx) =>
        putAccount(world, tx, { ...account, health: result, lastSyncedAt: synced ? env.now() : account.lastSyncedAt }),
      )
    }
    return result
  }

  function onCommand(change: ChangeId, command: Command) {
    const earlier = world.changes.get(change)
    if (earlier) {
      send({ kind: 'accepted', change, rev: earlier.acceptedRev })
      if (earlier.outcome) send({ kind: 'settled', change, rev: earlier.outcome.rev, result: earlier.outcome.result })
      return
    }
    const accepted = (rev: Rev) => send({ kind: 'accepted', change, rev })

    if (command.kind === 'set-turn') {
      // A turn correction never leaves the device, so it is done as soon as it is stored.
      const target = targets(world, command.threadIds)
      if (!target.ok) return send({ kind: 'rejected', change, reason: target.reason })
      const override = command.turn === 'auto' ? null : command.turn
      const rev = commit((tx, at) => {
        for (const id of target.threadIds) {
          const thread = world.threads.get(id)
          if (thread) putThread(world, tx, { ...thread, override })
        }
        putChange(world, tx, {
          id: change,
          accountId: target.accountId,
          op: null,
          acceptedRev: at,
          outcome: { rev: at, result: 'done' },
        })
      }, accepted)
      return send({ kind: 'settled', change, rev, result: 'done' })
    }

    const resolved = resolve(world, command)
    if (!resolved.ok) return send({ kind: 'rejected', change, reason: resolved.reason })
    commit(
      (tx, at) =>
        putChange(world, tx, {
          id: change,
          accountId: resolved.accountId,
          op: resolved.op,
          acceptedRev: at,
          outcome: null,
        }),
      accepted,
    )
    background(resolved.accountId, () => pass(resolved.accountId, false))
  }

  async function signIn(id: RequestId, request: Extract<Request, { method: 'sign-in' }>) {
    const factory = factories.get(request.option)
    if (!factory) return send({ kind: 'response', id, method: 'sign-in', ok: false, error: 'denied' })

    // One attempt per option at a time. A new one ends the one before it and waits for
    // that one to be answered, so the two answers always arrive in the order asked.
    const prior = signIns.get(request.option)
    const answered = Promise.withResolvers<void>()
    const attempt = { controller: new AbortController(), superseded: false, answered: answered.promise }
    signIns.set(request.option, attempt)
    try {
      if (prior) {
        prior.superseded = true
        prior.controller.abort()
        await prior.answered
      }
      await connect(id, request, factory, attempt)
    } finally {
      if (signIns.get(request.option) === attempt) signIns.delete(request.option)
      answered.resolve()
    }
  }

  /** Runs one sign-in attempt to its answer. */
  async function connect(
    id: RequestId,
    request: Extract<Request, { method: 'sign-in' }>,
    factory: AdapterFactory,
    attempt: { controller: AbortController; superseded: boolean },
  ) {
    const superseded = () => send({ kind: 'response', id, method: 'sign-in', ok: false, error: 'superseded' })
    if (attempt.superseded) return superseded()
    const result = await factory.connect({
      ...(request.password && { password: request.password }),
      openUrl: (url) => send({ kind: 'open-url', id, url }),
      signal: attempt.controller.signal,
    })
    if (attempt.superseded) {
      if (result.ok) await result.adapter.close()
      return superseded()
    }
    if (!result.ok) return send({ kind: 'response', id, method: 'sign-in', ok: false, error: result.failure })

    const existing = [...world.accounts.values()].find(
      (account) =>
        account.factoryId === factory.option.id && account.address.toLowerCase() === result.address.toLowerCase(),
    )
    const accountId = existing?.id ?? store.nextId('accounts')
    await adapters.get(accountId)?.close()
    adapters.set(accountId, result.adapter)
    commit((tx) =>
      putAccount(world, tx, {
        id: accountId,
        address: result.address,
        providerLabel: result.providerLabel,
        factoryId: factory.option.id,
        session: result.session,
        capabilities: result.adapter.capabilities,
        cursor: existing?.cursor ?? null,
        lastSyncedAt: existing?.lastSyncedAt ?? null,
        health: 'ok',
      }),
    )
    send({ kind: 'response', id, method: 'sign-in', ok: true, result: { accountId } })
    background(accountId, () => pass(accountId, true))
  }

  async function signOut(id: RequestId, request: Extract<Request, { method: 'sign-out' }>) {
    const { accountId } = request
    const adapter = adapters.get(accountId)
    adapters.delete(accountId)
    await adapter?.close()
    commit((tx) => {
      const account = world.accounts.get(accountId)
      if (!account) return
      if (!request.deleteLocalMail) return putAccount(world, tx, { ...account, session: '', health: 'needs-sign-in' })
      for (const record of world.messages.values()) if (record.accountId === accountId) removeMessage(world, tx, record)
      for (const record of world.threads.values())
        if (record.accountId === accountId) removeThread(world, tx, record.id)
      for (const record of world.mailboxes.values())
        if (record.accountId === accountId) removeMailbox(world, tx, record)
      for (const record of world.changes.values())
        if (record.accountId === accountId) removeChange(world, tx, record.id)
      removeAccount(world, tx, accountId)
    })
    send({ kind: 'response', id, method: 'sign-out', ok: true, result: {} })
  }

  async function onRequest(id: RequestId, request: Request) {
    switch (request.method) {
      case 'sign-in':
        return signIn(id, request)
      case 'sign-out':
        return signOut(id, request)
      case 'sync-now': {
        let offline = false
        for (const accountId of request.accountId ? [request.accountId] : [...world.accounts.keys()]) {
          if ((await enqueue(accountId, () => pass(accountId, true))) === 'offline') offline = true
        }
        if (offline) return send({ kind: 'response', id, method: 'sync-now', ok: false, error: 'offline' })
        return send({ kind: 'response', id, method: 'sync-now', ok: true, result: {} })
      }
      case 'blob':
        return send({ kind: 'response', id, method: 'blob', ok: false, error: 'not-supported' })
    }
  }

  return {
    receive(value) {
      const parsed = parseClientMessage(value)
      if (!parsed.ok) return send({ kind: 'protocol-error', reason: 'malformed', detail: parsed.problem })
      const message = parsed.message
      switch (message.kind) {
        case 'hello':
          if (message.protocol !== PROTOCOL) {
            return send({
              kind: 'protocol-error',
              reason: 'version-mismatch',
              detail: `this core speaks protocol ${PROTOCOL}`,
            })
          }
          return send({ kind: 'welcome', protocol: PROTOCOL, rev: store.rev() })
        case 'subscribe':
          subscriptions.set(message.sub, { query: message.query, sent: '' })
          return flush()
        case 'unsubscribe':
          return void subscriptions.delete(message.sub)
        case 'command':
          return onCommand(message.change, message.command)
        case 'request':
          return void onRequest(message.id, message.request).catch((error: unknown) =>
            log(`request ${message.id} failed: ${String(error)}`),
          )
      }
    },
    async close() {
      await Promise.allSettled(queues.values())
      await Promise.allSettled([...adapters.values()].map((adapter) => adapter.close()))
      store.close()
    },
  }
}
