// Times a core program through the shared client in @letterbox/client, the way a UI
// uses it, against a large mailbox at the sim provider.
//
//   pnpm bench                                     the Rust core, release build
//   pnpm bench --sizes 1000,10000 --runs 3         mailbox sizes and runs per size
//   pnpm bench:scale                               10k and 100k messages, one run each
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
import { DatabaseSync } from 'node:sqlite'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { createClient, type KeepingClient } from '@letterbox/client'
import type { CoreMessage, ThreadId } from '@letterbox/protocol'
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
/** How many HTML newsletters, and how many long quoted replies, the bench opens. */
const HTML_OPENED = 20

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

/**
 * A newsletter of about 22 KB, built the way marketing mail is: nested tables, inline styles,
 * a `<style>` block, a remote image and a tracker per story, and a footer with an unsubscribe link.
 */
function newsletterHtml(n: number): string {
  const story = (index: number) =>
    `<tr><td style="padding:16px;background:#fafafa;border-bottom:1px solid #eee">` +
    `<img src="https://cdn.news.example/${n}/story-${index}.jpg" width="560" alt="Story ${index}" style="display:block">` +
    `<h2 style="font:600 20px Georgia,serif;color:#222">Story ${index} of issue ${n}</h2>` +
    `<p style="font:15px/22px Georgia,serif;color:#444">${'A paragraph of the story, long enough to look like one. '.repeat(8)}</p>` +
    `<a href="https://news.example/r/${n}/${index}" style="color:#c60">Read more</a>` +
    `<img src="https://news.example/open.gif?u=${n}&s=${index}" width="1" height="1" alt=""></td></tr>`
  const stories = Array.from({ length: 24 }, (_, index) => story(index)).join('')
  return (
    `<style>td{font-family:Georgia,serif}.hero{background:url(https://cdn.news.example/${n}/bg.png)}</style>` +
    `<table width="100%" cellpadding="0" cellspacing="0"><tr><td class="hero"><table width="600">${stories}</table></td></tr></table>` +
    `<p><a href="https://news.example/unsubscribe?u=${n}">Unsubscribe</a></p>`
  )
}

/** A reply of about 20 KB that quotes ten earlier messages, each nested in the last, as Gmail writes it. */
function quotedHtml(n: number): string {
  let quote = ''
  for (let level = 0; level < 10; level += 1) {
    const words = `<p>${`Message ${level} of thread ${n}, with its own words. `.repeat(40)}</p>`
    quote = `<div class="gmail_quote"><div class="gmail_attr">On Mon, Dec 1, 2025, Person ${level} wrote:<br></div><blockquote class="gmail_quote">${words}${quote}</blockquote></div>`
  }
  return `<div dir="ltr">Thanks, that settles it.</div><br>${quote}`
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

/**
 * A core process behind the shared client. Unlike the scenarios' client it checks nothing,
 * records nothing and hands each message on as it arrives, so it costs little and the
 * same for every core.
 */
function startCore(data: string, socket: string) {
  const [program = '', ...args] = command
  const child = spawn(program, [...args, '--data', data, '--sim', socket], { stdio: ['pipe', 'pipe', 'inherit'] })
  let counter = 0
  const client = createClient(
    {
      send: (message) => void child.stdin.write(`${JSON.stringify(message)}\n`),
      listen: (listener) => {
        // The core under test sends protocol messages. The scenarios check their shapes.
        createInterface({ input: child.stdout }).on('line', (line) => listener.receive(JSON.parse(line) as CoreMessage))
        child.on('exit', (code) => listener.end(new Error(`the core exited with code ${code}`)))
      },
    },
    { newId: (kind) => `${kind}_${++counter}`, unclaimed: 'keep' },
  )
  const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()))
  return {
    ...client,
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

/** Sends a command and waits for it to settle. */
async function settle(core: KeepingClient, threadId: ThreadId, flags: { unread?: boolean; flagged?: boolean }) {
  const answer = await core.command({ kind: 'set-flags', threadIds: [threadId], ...flags })
  if (answer.kind === 'rejected') throw new Error(`the core rejected a command: ${answer.reason}`)
  await core.settled(answer.change)
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
    await core.hello()
    phases['start (ms)'] = now() - at

    // What a UI keeps open: the accounts, the mailbox list, the first page of the inbox, the
    // People screen's Your turn and Let go?, which filter by turn and split on age, and Updates,
    // which groups automated mail by sender. Each reads every thread's row when it opens.
    const accounts = core.subscribe({ view: 'accounts' })
    await accounts.next()
    const mailboxes = core.subscribe({ view: 'mailboxes' })
    await mailboxes.next()
    const list = core.subscribe({ view: 'threads', filter: {}, offset: 0, limit: 50 })
    await list.next()
    const people = core.subscribe({ view: 'threads', filter: { turn: 'mine', retired: false }, offset: 0, limit: 50 })
    await people.next()
    const letGo = core.subscribe({ view: 'threads', filter: { turn: 'mine', retired: true }, offset: 0, limit: 50 })
    await letGo.next()
    const updates = core.subscribe({ view: 'senders', zone: 'America/Chicago', offset: 0, limit: 50 })
    await updates.next()

    const options = await core.query({ view: 'sign-in-options' })
    const password = options.find((option) => option.method === 'password')
    if (!password) throw new Error('the core lists no password sign-in option')
    at = now()
    await core.request({ method: 'sign-in', option: password.id, password: { username: ME, password: PASSWORD } })
    const synced = await core.request({ method: 'sync-now' })
    phases['sign-in and first sync (ms)'] = now() - at
    if (!synced.ok) throw new Error('the first sync failed')

    // A conversation's toolbar reads its sender's Updates row through a view of that one
    // address, which opens from the rows' address lookup, not by reading every row.
    at = now()
    const oneSender = core.subscribe({
      view: 'senders',
      zone: 'America/Chicago',
      address: 'person0@example.com',
      offset: 0,
      limit: 1,
    })
    const sender = await oneSender.next()
    phases['open a one-sender Updates view (ms)'] = now() - at
    if (sender.senders.length !== 1) throw new Error('the one-sender view holds no row for person0@example.com')
    oneSender.close()

    const page = await core.query({ view: 'threads', filter: {}, offset: 0, limit: COMMANDS * 2 })
    if (page.total !== conversations) throw new Error(`expected ${conversations} threads, the core lists ${page.total}`)
    const threadIds: ThreadId[] = page.threads.map((thread) => thread.id)
    const [first] = threadIds
    if (!first) throw new Error('the core lists no threads')

    at = now()
    const open = core.subscribe({ view: 'thread', threadId: first })
    // Read the newest update before each wait, so no update between two waits is missed.
    while (!open.latest()?.messages.every((item) => item.body.state === 'ready')) await open.next()
    phases['open a conversation (ms)'] = now() - at

    // One command at a time, as a person clicks: wait for each to settle before the next.
    at = now()
    for (const threadId of threadIds.slice(0, COMMANDS)) await settle(core, threadId, { unread: false })
    phases[`${COMMANDS} commands one by one, per command (ms)`] = (now() - at) / COMMANDS

    // A burst, as a select-all would send: all at once, then wait for the last to settle.
    at = now()
    await Promise.all(
      threadIds.slice(COMMANDS, COMMANDS * 2).map((threadId) => settle(core, threadId, { flagged: true })),
    )
    phases[`${COMMANDS} commands at once, total (ms)`] = now() - at

    for (let index = 0; index < DELIVERED; index += 1) box.deliver(benchMessage(size + index, conversations + index, 0))
    at = now()
    await core.request({ method: 'sync-now' })
    phases[`sync after ${DELIVERED} new messages (ms)`] = now() - at

    // HTML mail, delivered after the first sync, so its bodies are fetched and processed as
    // each conversation opens: the body pipeline's cost, and what it adds to the store.
    const html: SeedMessage[] = []
    for (let index = 0; index < HTML_OPENED * 2; index += 1) {
      const newsletter = index < HTML_OPENED
      html.push({
        key: `html${index}`,
        mailboxes: ['inbox'],
        from: newsletter
          ? { name: 'The News', address: 'issue@news.example' }
          : { name: 'Person', address: 'person@example.com' },
        to: [ME],
        subject: newsletter ? `Issue ${index}` : `Plans ${index}`,
        text: newsletter ? `Issue ${index}.` : 'Thanks, that settles it.',
        html: newsletter ? newsletterHtml(index) : quotedHtml(index),
        sentAt: new Date(Date.UTC(2026, 0, 1) + index * 60_000).toISOString(),
        ...(newsletter && {
          headers: { listUnsubscribe: '<https://news.example/u>', listUnsubscribePost: 'List-Unsubscribe=One-Click' },
        }),
      })
    }
    for (const message of html) box.deliver(message)
    await core.request({ method: 'sync-now' })
    // The bytes the store keeps for these messages' records, read beside the running core.
    const recordBytes = (prefix: string) => {
      const store = new DatabaseSync(join(data, 'letterbox.sqlite'), { readOnly: true })
      try {
        const row = store
          .prepare(
            "select sum(length(record)) as bytes from messages where json_extract(record, '$.facts.subject') like ?",
          )
          .get(`${prefix}%`)
        return Number(row?.['bytes'] ?? 0)
      } finally {
        store.close()
      }
    }
    const listed = await core.query({ view: 'threads', filter: {}, offset: 0, limit: HTML_OPENED * 2 })
    const byKind = (prefix: string) => listed.threads.filter((thread) => thread.subject.startsWith(prefix))
    for (const [prefix, name] of [
      ['Issue', 'open an html newsletter'],
      ['Plans', 'open a long quoted reply'],
    ] as const) {
      const before = recordBytes(prefix)
      at = now()
      for (const thread of byKind(prefix)) {
        const opened = core.subscribe({ view: 'thread', threadId: thread.id })
        while (!opened.latest()?.messages.every((item) => item.body.state === 'ready')) await opened.next()
        opened.close()
      }
      phases[`${name}, per message (ms)`] = (now() - at) / HTML_OPENED
      const raw = html.filter((message) => message.subject.startsWith(prefix))
      const rawBytes = raw.reduce((sum, message) => sum + Buffer.byteLength(message.html ?? ''), 0) / HTML_OPENED
      phases[`${name}: html as sent, per message (KB)`] = rawBytes / 1024
      phases[`${name}: stored record growth, per message (KB)`] = (recordBytes(prefix) - before) / HTML_OPENED / 1024
    }

    phases['peak memory (MB)'] = core.peakMegabytes()
    list.close()
    people.close()
    letGo.close()
    updates.close()
    at = now()
    await core.stop()
    phases['stop (ms)'] = now() - at

    at = now()
    core = startCore(data, provider.socketPath)
    await core.hello()
    await core.query({ view: 'threads', filter: {}, offset: 0, limit: 50 })
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
