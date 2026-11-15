// Self-check for the client, over a transport held in memory. Run from the repo root:
//   node packages/client/src/selfcheck.ts
// It uses nothing from Node, so passing it also shows the client runs without Node.
//
// Every way the client could be wrong for an app. Each line has one check below with the same id.
//
//   C01 a change id comes from somewhere other than `newId`, so ids can repeat across app restarts
//   C02 a live view loses its newest update or miscounts updates
//   C03 with an `unclaimed` function, a message nothing waits for is held instead of handed over
//   C04 a `next` waiting when the view closes or the core goes away never settles, nor does one made after
//   C05 an answer sent from inside `send` arrives before its wait exists and is lost
//   C06 with 'keep', a message that arrived before its wait is lost

import type { ClientMessage, CoreMessage, RequestId, SubscriptionId } from '@letterbox/protocol'
import { createClient, type Listener, type Options } from './client.ts'

/** A transport held in memory. `answer` runs inside `send`, the way a synchronous native bridge would. */
const memory = (answer: (message: ClientMessage, listener: Listener) => void = () => {}) => {
  const sent: ClientMessage[] = []
  let listener: Listener | undefined
  return {
    sent,
    deliver: (message: CoreMessage) => listener?.receive(message),
    end: (error: Error) => listener?.end(error),
    transport: {
      send: (message: ClientMessage) => {
        sent.push(message)
        if (listener) answer(message, listener)
      },
      listen: (given: Listener) => void (listener = given),
    },
  }
}

const ids = (): Options['newId'] => {
  let count = 0
  return (kind) => `${kind}_from_new_id_${++count}`
}

const fail = (what: string): never => {
  throw new Error(what)
}

/** Resolves true if `promise` settles, false if it is still pending once queued work has run. */
const settles = async (promise: Promise<unknown>) => {
  let done = false
  promise.then(
    () => (done = true),
    () => (done = true),
  )
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve()
  return done
}

const checks: [string, () => Promise<void>][] = [
  [
    'C01 change ids come from newId',
    async () => {
      const wire = memory()
      const client = createClient(wire.transport, { newId: ids(), unclaimed: () => {} })
      void client.command({ kind: 'trash', threadIds: [] })
      const sent = wire.sent.at(-1)
      if (sent?.kind !== 'command' || !sent.change.startsWith('change_from_new_id_'))
        fail(`sent ${JSON.stringify(sent)}`)
    },
  ],
  [
    'C02 a live view keeps its newest update and counts every one',
    async () => {
      const wire = memory()
      const client = createClient(wire.transport, { newId: ids(), unclaimed: () => {} })
      const view = client.subscribe({ view: 'accounts' })
      const sub = (wire.sent.at(-1) as { sub: SubscriptionId }).sub
      for (const rev of [1, 2, 3]) wire.deliver({ kind: 'update', sub, rev, view: 'accounts', data: [] })
      if (view.count() !== 3 || view.rev() !== 3) fail(`count ${view.count()}, rev ${view.rev()}`)
      const next = view.next()
      wire.deliver({ kind: 'update', sub, rev: 4, view: 'accounts', data: [] })
      if ((await next).length !== 0 || view.rev() !== 4) fail('next did not get the update that came after it')
    },
  ],
  [
    'C03 an unclaimed function receives what nothing waits for, and nothing is held',
    async () => {
      const handed: CoreMessage[] = []
      const wire = memory()
      createClient(wire.transport, { newId: ids(), unclaimed: (message) => handed.push(message) })
      const settled: CoreMessage = { kind: 'settled', change: 'change_9' as never, rev: 1, result: 'done' }
      wire.deliver(settled)
      if (handed.length !== 1 || handed[0] !== settled) fail(`handed ${JSON.stringify(handed)}`)
    },
  ],
  [
    'C04 close and end reject waiting and later next calls',
    async () => {
      const wire = memory()
      const client = createClient(wire.transport, { newId: ids(), unclaimed: () => {} })
      const closing = client.subscribe({ view: 'accounts' })
      const waiting = closing.next()
      closing.close()
      if (!(await settles(waiting))) fail('a next waiting at close never settled')
      if (!(await settles(closing.next()))) fail('a next after close never settled')
      const ending = client.subscribe({ view: 'mailboxes' })
      const waitingAtEnd = ending.next()
      wire.end(new Error('the core is gone'))
      if (!(await settles(waitingAtEnd))) fail('a next waiting at end never settled')
      if (!(await settles(ending.next()))) fail('a next after end never settled')
      if (!(await settles(client.hello()))) fail('a hello after end never settled')
    },
  ],
  [
    'C05 an answer from inside send reaches its wait',
    async () => {
      const wire = memory((message, listener) => {
        if (message.kind === 'hello') listener.receive({ kind: 'welcome', protocol: message.protocol, rev: 7 })
        if (message.kind === 'command') listener.receive({ kind: 'accepted', change: message.change, rev: 8 })
        if (message.kind === 'request') {
          const { id } = message
          listener.receive({ kind: 'response', id, method: 'blob', ok: false, error: 'not-supported' })
        }
      })
      const handed: CoreMessage[] = []
      const client = createClient(wire.transport, { newId: ids(), unclaimed: (message) => handed.push(message) })
      const welcome = client.hello()
      const accepted = client.command({ kind: 'trash', threadIds: [] })
      const response = client.request({ method: 'blob', blobId: 'blob_1' as never })
      if (!(await settles(welcome))) fail('the welcome was lost')
      if (!(await settles(accepted))) fail('the accepted was lost')
      if (!(await settles(response))) fail('the response was lost')
      if (handed.length !== 0) fail(`answers went to unclaimed: ${JSON.stringify(handed)}`)
    },
  ],
  [
    "C06 with 'keep', a message that came first is found by the wait made after it",
    async () => {
      const wire = memory()
      const client = createClient(wire.transport, { newId: ids(), unclaimed: 'keep' })
      wire.deliver({ kind: 'settled', change: 'change_1' as never, rev: 2, result: 'done' })
      wire.deliver({ kind: 'open-url', id: 'req_1' as RequestId, url: 'sim://sign-in/1' })
      if ((await client.settled('change_1' as never)).rev !== 2) fail('the settled was lost')
      if ((await client.take('open-url')).url !== 'sim://sign-in/1') fail('the open-url was lost')
    },
  ],
]

let failed = 0
for (const [name, run] of checks) {
  try {
    await run()
    console.log(`PASS ${name}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}
console.log(`${checks.length - failed} passed, ${failed} failed`)
if (failed > 0) throw new Error(`${failed} client checks failed`)
