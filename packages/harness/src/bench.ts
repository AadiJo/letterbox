// Times a core program through the protocol, the way a UI uses it, against a large
// mailbox at the sim provider.
//
//   pnpm bench                                     the Rust core, release build
//   pnpm bench --sizes 1000,10000 --runs 3         mailbox sizes and runs per size
//   pnpm bench --core "<command>" --label <name>   any other core program with the same arguments
//
// To compare with the TypeScript core this repo used to have (commit 1451819):
//   mkdir -p /tmp/letterbox-ts && git archive 1451819 | tar -x -C /tmp/letterbox-ts
//   (cd /tmp/letterbox-ts && pnpm install --frozen-lockfile --ignore-scripts)
//   pnpm bench --core "node /tmp/letterbox-ts/packages/harness/src/core-main.ts" --label ts
//
// Each phase is wall time measured here, so the sim provider and this process count the
// same for every core. Writes the median of each phase to artifacts/bench/<label>.json.

import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import type { CoreMessage, ThreadId, ThreadSummary } from '@letterbox/protocol'
import type { Seed, SeedMailbox, SeedMessage, SimMailbox } from '@letterbox/sim-provider/contract'
import { startSimProvider } from '@letterbox/sim-provider/server'
import { ME, PASSWORD } from './fixtures.ts'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const { values } = parseArgs({
  options: {
    core: { type: 'string' },
    label: { type: 'string' },
    sizes: { type: 'string', default: '1000,10000' },
    runs: { type: 'string', default: '3' },
  },
})

/** The program to time and the name its results go under. Without --core, the Rust core's release build. */
const command = values.core?.split(' ') ?? [join(ROOT, 'target/release/core-sim')]
const label = values.label ?? (values.core ? 'other' : 'rust')
const sizes = values.sizes.split(',').map(Number)
const runs = Number(values.runs)
const COMMANDS = 100
const DELIVERED = 200

if (!values.core) {
  const build = spawnSync('cargo', ['build', '--quiet', '--release', '--bin', 'core-sim'], {
    cwd: ROOT,
    stdio: 'inherit',
  })
  if (build.status !== 0) process.exit(2)
}

// ---------------------------------------------------------------- the mailbox

const MAILBOXES: SeedMailbox[] = [
  { key: 'inbox', name: 'Inbox', role: 'inbox' },
  { key: 'sent', name: 'Sent', role: 'sent' },
  { key: 'archive', name: 'Archive', role: 'archive' },
  { key: 'trash', name: 'Trash', role: 'trash' },
  ...Array.from({ length: 10 }, (_, index): SeedMailbox => ({
    key: `label-${index}`,
    name: `Label ${index}`,
    role: null,
  })),
]

/**
 * One message of a mailbox made of conversations of one to four messages. Every
 * second message in a conversation is mine, every seventh conversation is a
 * newsletter, and every fifth also carries a label.
 */
function benchMessage(index: number, conversation: number, place: number): SeedMessage {
  const other = { name: `Person ${conversation % 300}`, address: `person${conversation % 300}@example.com` }
  const mine = place % 2 === 1
  const key = `m${index}`
  return {
    key,
    mailboxes: mine ? ['sent'] : conversation % 5 === 0 ? ['inbox', `label-${conversation % 10}`] : ['inbox'],
    from: mine ? ME : other,
    to: mine ? [other] : [ME],
    subject: place === 0 ? `Topic ${conversation}` : `Re: Topic ${conversation}`,
    text: `Message ${key} in a conversation about topic ${conversation}.`,
    sentAt: new Date(Date.UTC(2025, 0, 1) + index * 60_000).toISOString(),
    unread: index % 3 === 0,
    ...(place > 0 && { replyTo: [`m${index - 1}`] }),
    ...(conversation % 7 === 0 && { headers: { listUnsubscribe: true } }),
  }
}

function benchSeed(size: number): { seed: Seed; conversations: number } {
  const messages: SeedMessage[] = []
  let conversation = 0
  while (messages.length < size) {
    const length = 1 + (conversation % 4)
    for (let place = 0; place < length && messages.length < size; place += 1) {
      messages.push(benchMessage(messages.length, conversation, place))
    }
    conversation += 1
  }
  return {
    seed: { address: ME, password: PASSWORD, pageSize: 200, mailboxes: MAILBOXES, messages },
    conversations: conversation,
  }
}

// ---------------------------------------------------------------- a lean client

type Of<Kind extends CoreMessage['kind']> = Extract<CoreMessage, { kind: Kind }>

/** A core process. It checks nothing and records nothing, so the client costs little and the same for every core. */
function startCore(data: string, socket: string) {
  const [program = '', ...args] = command
  const child = spawn(program, [...args, '--data', data, '--sim', socket], { stdio: ['pipe', 'pipe', 'inherit'] })
  const waiters: { match: (message: CoreMessage) => boolean; resolve: (message: CoreMessage) => void }[] = []
  createInterface({ input: child.stdout }).on('line', (line) => {
    // The core under test sends protocol messages. The scenarios check their shapes.
    const message = JSON.parse(line) as CoreMessage
    const at = waiters.findIndex((waiter) => waiter.match(message))
    if (at !== -1) waiters.splice(at, 1)[0]?.resolve(message)
  })
  const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()))
  let counter = 0
  return {
    send: (message: unknown) => void child.stdin.write(`${JSON.stringify(message)}\n`),
    id: (prefix: string) => `${prefix}_${++counter}`,
    /** Resolves with the next message that passes `match`. Register it before sending what causes it. */
    next: <Message extends CoreMessage>(match: (message: CoreMessage) => message is Message) =>
      new Promise<Message>((resolve) => waiters.push({ match, resolve: (message) => resolve(message as Message) })),
    /** Peak resident memory in megabytes, from /proc. */
    peakMegabytes: () => {
      const status = readFileSync(`/proc/${child.pid}/status`, 'utf8')
      return Number(/VmHWM:\s+(\d+) kB/.exec(status)?.[1] ?? 0) / 1024
    },
    stop: async () => {
      child.stdin.end()
      await exited
    },
  }
}

type Core = ReturnType<typeof startCore>

const isKind =
  <Kind extends CoreMessage['kind']>(kind: Kind) =>
  (message: CoreMessage): message is Of<Kind> =>
    message.kind === kind

/** Waits for the answer to one request. */
async function request(core: Core, body: Record<string, unknown>): Promise<Of<'response'>> {
  const id = core.id('req')
  const answer = core.next((message): message is Of<'response'> => message.kind === 'response' && message.id === id)
  core.send({ kind: 'request', id, request: body })
  return answer
}

/** Subscribes and resolves with the first update. */
async function subscribe(core: Core, query: Record<string, unknown>): Promise<{ sub: string; first: Of<'update'> }> {
  const sub = core.id('sub')
  const first = core.next((message): message is Of<'update'> => message.kind === 'update' && message.sub === sub)
  core.send({ kind: 'subscribe', sub, query })
  return { sub, first: await first }
}

const now = () => performance.now()

// ---------------------------------------------------------------- one run

type Phases = Record<string, number>

async function run(size: number): Promise<Phases> {
  const folder = mkdtempSync(join(tmpdir(), 'letterbox-bench-'))
  const provider = await startSimProvider(join(folder, 'provider.sock'))
  const { seed, conversations } = benchSeed(size)
  const box: SimMailbox = provider.createMailbox('labels', seed)
  const data = join(folder, 'data')
  const phases: Phases = {}
  try {
    let at = now()
    let core = startCore(data, provider.socketPath)
    const welcome = core.next(isKind('welcome'))
    core.send({ kind: 'hello', protocol: 0 })
    await welcome
    phases['start (ms)'] = now() - at

    // What a UI keeps open: the accounts, the mailbox list and the first page of the inbox.
    await subscribe(core, { view: 'accounts' })
    await subscribe(core, { view: 'mailboxes' })
    const list = await subscribe(core, { view: 'threads', filter: {}, offset: 0, limit: 50 })

    at = now()
    await request(core, { method: 'sign-in', option: 'sim-password', password: { username: ME, password: PASSWORD } })
    const synced = await request(core, { method: 'sync-now' })
    phases['sign-in and first sync (ms)'] = now() - at
    if (!synced.ok) throw new Error('the first sync failed')

    const all = await subscribe(core, { view: 'threads', filter: {}, offset: 0, limit: COMMANDS * 2 })
    const page = all.first.data as { total: number; threads: ThreadSummary[] }
    if (page.total !== conversations) throw new Error(`expected ${conversations} threads, the core lists ${page.total}`)
    const threadIds: ThreadId[] = page.threads.map((thread) => thread.id)
    core.send({ kind: 'unsubscribe', sub: all.sub })

    at = now()
    const thread = core.id('sub')
    const ready = core.next(
      (message): message is Of<'update'> =>
        message.kind === 'update' &&
        message.sub === thread &&
        message.view === 'thread' &&
        message.data !== null &&
        message.data.messages.every((item) => item.body.state === 'ready'),
    )
    core.send({ kind: 'subscribe', sub: thread, query: { view: 'thread', threadId: threadIds[0] } })
    await ready
    phases['open a conversation (ms)'] = now() - at

    // One command at a time, as a person clicks: wait for each to settle before the next.
    at = now()
    for (const threadId of threadIds.slice(0, COMMANDS)) {
      const change = core.id('change')
      const settled = core.next(
        (message): message is Of<'settled'> => message.kind === 'settled' && message.change === change,
      )
      core.send({ kind: 'command', change, command: { kind: 'set-flags', threadIds: [threadId], unread: false } })
      await settled
    }
    phases[`${COMMANDS} commands one by one, per command (ms)`] = (now() - at) / COMMANDS

    // A burst, as a select-all would send: all at once, then wait for the last to settle.
    at = now()
    const changes = threadIds.slice(COMMANDS, COMMANDS * 2).map((threadId) => ({ change: core.id('change'), threadId }))
    const settledAll = Promise.all(
      changes.map(({ change }) =>
        core.next((message): message is Of<'settled'> => message.kind === 'settled' && message.change === change),
      ),
    )
    for (const { change, threadId } of changes) {
      core.send({ kind: 'command', change, command: { kind: 'set-flags', threadIds: [threadId], flagged: true } })
    }
    await settledAll
    phases[`${COMMANDS} commands at once, total (ms)`] = now() - at

    for (let index = 0; index < DELIVERED; index += 1) box.deliver(benchMessage(size + index, conversations + index, 0))
    at = now()
    await request(core, { method: 'sync-now' })
    phases[`sync after ${DELIVERED} new messages (ms)`] = now() - at

    phases['peak memory (MB)'] = core.peakMegabytes()
    core.send({ kind: 'unsubscribe', sub: list.sub })
    at = now()
    await core.stop()
    phases['stop (ms)'] = now() - at

    at = now()
    core = startCore(data, provider.socketPath)
    const again = core.next(isKind('welcome'))
    core.send({ kind: 'hello', protocol: 0 })
    await again
    await subscribe(core, { view: 'threads', filter: {}, offset: 0, limit: 50 })
    phases['restart to first list (ms)'] = now() - at
    await core.stop()

    const store = join(data, 'letterbox.sqlite')
    const wal = `${store}-wal`
    const bytes = statSync(store).size + (statSync(wal, { throwIfNoEntry: false })?.size ?? 0)
    phases['store size (MB)'] = bytes / 1024 / 1024
    return phases
  } finally {
    await provider.close()
    rmSync(folder, { recursive: true, force: true })
  }
}

const median = (numbers: number[]) => numbers.toSorted((a, b) => a - b)[Math.floor(numbers.length / 2)] ?? 0

const results: Record<string, Phases> = {}
for (const size of sizes) {
  const each: Phases[] = []
  for (let index = 0; index < runs; index += 1) each.push(await run(size))
  const phases: Phases = {}
  for (const name of Object.keys(each[0] ?? {})) phases[name] = median(each.map((one) => one[name] ?? 0))
  results[`${size} messages`] = phases
  console.log(`\n${label}, ${size} messages, median of ${runs}`)
  for (const [name, value] of Object.entries(phases))
    console.log(`  ${name.padEnd(42)} ${value.toFixed(1).padStart(9)}`)
}

const folder = join(ROOT, 'artifacts', 'bench')
mkdirSync(folder, { recursive: true })
writeFileSync(join(folder, `${label}.json`), `${JSON.stringify({ label, command, runs, results }, null, 2)}\n`)
console.log(`\nWrote artifacts/bench/${label}.json`)
