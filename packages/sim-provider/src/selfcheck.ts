// Self-check for the sim provider. Run from the repo root:
//   node packages/sim-provider/src/selfcheck.ts
//
// Every way this sim provider could be wrong. Each line has one check below with the same id.
// A "B" line runs once per dialect.
//
//   L01 labels: snapshot is not newest first, or misses the mailbox list or the cursor
//   L02 labels: capabilities are wrong, or bulk ignores the seed
//   L03 labels: a message in zero mailboxes disappears from the listing
//   L04 labels: changes invents entries when nothing happened, or its new cursor repeats old entries
//   L05 labels: a delivered message is missing from `added` or lacks its facts
//   L06 labels: a flag change lands in the wrong list or carries stale state
//   L07 labels: an expunged message is not in `removed`
//   L08 labels: a message added then changed shows up twice or with stale state
//   L09 labels: `mailboxes` is set when no mailbox was created, or null when one was
//   L10 labels: a ref changes when the message moves or its labels change
//   L11 labels: apply cannot add and remove membership freely
//   L12 labels: a cursor from before expireCursors still works, or the next snapshot cursor does not
//   L13 labels: an old but valid cursor does not replay everything since its position
//   L14 labels: control move leaves the message in its old mailboxes
//   F01 folders: capabilities are wrong, bulk is not null, or a message has other than one mailbox
//   F02 folders: a seed or delivery with zero or two mailboxes is accepted
//   F03 folders: addToMailbox or removeFromMailbox does not throw
//   F04 folders: the diff misses an added, removed or updated number, or reports an untouched one
//   F05 folders: a flag change is reported again after the cursor moved past it
//   F06 folders: a control move is not one removed ref plus one added ref, or the old ref still resolves
//   F07 folders: apply move does not list the ref pair in `moved`, or the echo disagrees with it
//   F08 folders: apply with other than one add and one remove is not refused as not-supported
//   F09 folders: a mailbox created since the cursor is not listed, or its messages are not added
//   F10 folders: expireCursors leaves a ref or cursor working
//   F11 folders: a number is reused after an expunge, so an old ref names a new message
//   B01 messageId, references or addresses are wrong
//   B02 preview keeps quoted lines, keeps runs of whitespace or exceeds 200 characters, or size is not bytes
//   B03 headers, hasAttachments, unread or flagged defaults are wrong
//   B04 body returns the wrong text, html or attachment entries
//   B05 body for an expunged ref does not answer gone
//   B06 paging ignores pageSize, drops the mailbox list from a page, or hands the cursor out early
//   B07 a delivery between pages is listed by a later page, or is missed by the next changes
//   B08 a flag change between pages is not reported by the next changes
//   B09 an expunge between pages breaks paging or is not reported as removed
//   B10 apply flags touches a flag that was undefined
//   B11 the core's own apply is not echoed by the next changes
//   B12 apply fails on a ref that is gone instead of skipping it
//   B13 apply with only gone refs does not answer unknown-target
//   B14 read-only: modify is true, or apply changes something
//   B15 refuseNextApply does not refuse, changes the truth, or refuses more than once
//   B16 offline: a call throws, answers something else, is counted, or changes the truth
//   B17 recovery: after going back online the same adapter and cursor do not work
//   B18 calls() miscounts a method
//   B19 truth() is out of delivery order, has unsorted mailbox keys, or keeps an expunged message
//   B20 a mailbox parent is not reported as the parent's ref
//   B21 answers to concurrent calls on one adapter get mixed up
//   S01 the factories are not "sim-password" then "sim-oauth" with the right methods
//   S02 password sign-in fails with the right password, or reports the wrong address or label
//   S03 a wrong password is accepted or answers the wrong failure
//   S04 an unknown address or a missing password does not answer wrong-password
//   S05 password sign-in to an offline mailbox does not answer offline
//   S06 oauth does not open sim://sign-in/<n>, or approve signs in as the wrong mailbox
//   S07 two oauth attempts share a url, or approving one finishes the other
//   S08 denySignIn does not answer denied
//   S09 an aborted oauth attempt does not answer cancelled, or a late approve revives it
//   S10 oauth approved for an offline mailbox does not answer offline
//   S11 one provider mixes up two mailboxes, or labels both with the same dialect
//   C01 with no socket, sign-in or an adapter call throws instead of answering offline
//   C02 resume needs the password, loses capabilities, or does not reach the same mailbox
//   C03 resume connects eagerly, so it fails when the provider starts later
//   C04 an adapter does not recover after the provider restarts on the same socket
//   C05 a closed adapter still reaches the server
//   C06 provider close leaves the socket file or keeps accepting connections
//   H01 a held body call is answered before release, or from the truth at the time it was asked
//   H02 handedOut misses a ref, cursor, page token or session, or lists a fact a UI may show
//   H03 a held apply call is answered or changes the mailbox before release, or applyHeld
//       resolves before an apply call is held

import assert from 'node:assert/strict'
import { existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  Adapter,
  ChangeSet,
  Cursor,
  Mutation,
  PageToken,
  RemoteMailbox,
  RemoteMessage,
  RemoteState,
} from './adapter.ts'
import { simAdapterFactories } from './client.ts'
import type { Dialect, SimProvider, Seed, SeedMailbox, SeedMessage } from './contract.ts'
import { startSimProvider } from './server.ts'

// The process id keeps two runs at the same time off each other's socket.
const socketPath = join(tmpdir(), `letterbox-sim-selfcheck-${process.pid}.sock`)
const address = 'me@sim.test'
const password = 'hunter2'
const offline = { ok: false, failure: 'offline' }

const boxes: SeedMailbox[] = [
  { key: 'inbox', name: 'Inbox', role: 'inbox' },
  { key: 'archive', name: 'Archive', role: 'archive' },
  { key: 'work', name: 'Work', role: null },
]

/** Builds a seed message whose subject is its key, so a check can find it in adapter results. */
const mail = (key: string, mailbox = 'inbox', extra: Partial<SeedMessage> = {}): SeedMessage => ({
  key,
  mailboxes: [mailbox],
  from: 'ann@sim.test',
  to: [address],
  subject: key,
  text: `Text of ${key}`,
  sentAt: '2026-01-01T00:00:00Z',
  ...extra,
})

/** Builds the seed for the one mailbox most checks use. */
const seedOf = (messages: SeedMessage[], extra: Partial<Seed> = {}): Seed => ({
  address,
  password,
  mailboxes: boxes,
  messages,
  ...extra,
})

let passed = 0
let failed = 0
let cleanups: (() => Promise<void>)[] = []

/** Runs one check, prints PASS or FAIL with its name, then closes whatever the check opened. */
const check = async (name: string, run: () => Promise<void>): Promise<void> => {
  cleanups = []
  let problem: string | null = null
  try {
    await run()
  } catch (thrown) {
    problem = thrown instanceof Error ? thrown.message : String(thrown)
  }
  for (const cleanup of cleanups.toReversed()) await cleanup().catch(() => {})
  rmSync(socketPath, { force: true })
  if (problem === null) passed += 1
  else failed += 1
  console.log(problem === null ? `PASS ${name}` : `FAIL ${name}\n       ${problem.split('\n').join('\n       ')}`)
}

/** Runs the same check once per dialect. */
const both = async (name: string, run: (dialect: Dialect) => Promise<void>): Promise<void> => {
  for (const dialect of ['labels', 'folders'] as const) await check(`${name} [${dialect}]`, () => run(dialect))
}

/** Starts the provider on the self-check socket and closes it when the check ends. */
const start = async (): Promise<SimProvider> => {
  const provider = await startSimProvider(socketPath)
  cleanups.push(() => provider.close())
  return provider
}

/** Closes the adapter of a successful sign-in when the check ends. Returns the result unchanged. */
const track = <Result extends { ok: true; adapter: Adapter } | { ok: false }>(result: Result): Result => {
  if (result.ok) cleanups.push(() => result.adapter.close())
  return result
}

/** Signs in with the password factory. */
const signIn = async (username = address, secret = password) => {
  const [byPassword] = simAdapterFactories(socketPath)
  assert(byPassword, 'no password factory')
  const signal = new AbortController().signal
  return track(await byPassword.connect({ password: { username, password: secret }, openUrl: () => {}, signal }))
}

/** Starts an oauth attempt. `url` resolves when the adapter calls openUrl. */
const startOauth = (signal: AbortSignal = new AbortController().signal) => {
  const oauth = simAdapterFactories(socketPath)[1]
  assert(oauth, 'no oauth factory')
  const opened = Promise.withResolvers<string>()
  return { url: opened.promise, result: oauth.connect({ openUrl: opened.resolve, signal }).then(track) }
}

/** Starts a provider with one seeded mailbox and signs in to it by password. */
const open = async (dialect: Dialect, messages: SeedMessage[], extra: Partial<Seed> = {}) => {
  const provider = await start()
  const box = provider.createMailbox(dialect, seedOf(messages, extra))
  const connection = await signIn()
  assert(connection.ok, 'password sign-in failed')
  return { provider, box, adapter: connection.adapter, session: connection.session }
}

/** Reads one snapshot page and insists that it arrived. */
const pageOf = async (adapter: Adapter, token: PageToken | null) => {
  const page = await adapter.snapshot(token)
  assert(page.ok, 'snapshot did not answer ok')
  return page
}

/** Pages through a snapshot from `token` to the end. Checks that only the last page has a cursor. */
const snapshotFrom = async (adapter: Adapter, token: PageToken | null) => {
  const messages: RemoteMessage[] = []
  let next = token
  for (let pages = 1; ; pages += 1) {
    const page = await pageOf(adapter, next)
    messages.push(...page.messages)
    if (page.next === null) {
      assert(page.cursor !== null, 'the last page has no cursor')
      return { messages, mailboxes: page.mailboxes, cursor: page.cursor, pages }
    }
    assert.equal(page.cursor, null, 'a page before the last one has a cursor')
    next = page.next
  }
}

/** Reads `changes` and insists on a change set. */
const changesSince = async (adapter: Adapter, cursor: Cursor): Promise<ChangeSet> => {
  const result = await adapter.changes(cursor)
  assert(result.ok, 'changes did not answer ok')
  assert(result.kind === 'changes', `changes answered ${result.kind}`)
  return result
}

/** Checks that a change set reports nothing. */
const assertQuiet = (set: ChangeSet): void => {
  assert.deepEqual([set.added, set.updated, set.removed, set.mailboxes], [[], [], [], null])
}

const keys = (messages: RemoteMessage[]): string[] => messages.map((message) => message.subject)

/** Finds the message a seed key produced. */
const find = (messages: RemoteMessage[], key: string): RemoteMessage => {
  const found = messages.find((message) => message.subject === key)
  assert(found, `message ${key} is not listed`)
  return found
}

/** Finds a mailbox ref by display name. */
const boxRef = (mailboxes: RemoteMailbox[], name: string) => {
  const found = mailboxes.find((mailbox) => mailbox.name === name)
  assert(found, `mailbox ${name} is not listed`)
  return found.ref
}

/** The display names of the mailboxes a message is in, sorted. */
const boxNames = (mailboxes: RemoteMailbox[], state: RemoteState): string[] =>
  state.mailboxes.map((ref) => mailboxes.find((mailbox) => mailbox.ref === ref)?.name ?? `unknown ${ref}`).toSorted()

/** The state part of a listed message. */
const stateOf = ({ ref, mailboxes, unread, flagged }: RemoteMessage): RemoteState => ({
  ref,
  mailboxes,
  unread,
  flagged,
})

/** How many sockets this process holds open or is opening, the server's own included. */
const openPipes = (): number => process.getActiveResourcesInfo().filter((name) => name.startsWith('Pipe')).length

// ---------------------------------------------------------------- labels

await check('L01 labels: snapshot lists newest first, the mailbox list and a cursor', async () => {
  const { adapter } = await open('labels', [mail('a'), mail('b', 'archive'), mail('c')])
  const all = await snapshotFrom(adapter, null)
  assert.deepEqual(keys(all.messages), ['c', 'b', 'a'])
  assert.deepEqual(
    all.mailboxes.map((mailbox) => [mailbox.name, mailbox.role, mailbox.parent]),
    [
      ['Inbox', 'inbox', null],
      ['Archive', 'archive', null],
      ['Work', null, null],
    ],
  )
  assert.equal(all.pages, 1)
  assert.equal(new Set(all.mailboxes.map((mailbox) => mailbox.ref)).size, 3)
})

await check('L02 labels: capabilities and the bulk verdict', async () => {
  const { adapter } = await open('labels', [mail('a', 'inbox', { bulk: true }), mail('b')])
  assert.deepEqual(adapter.capabilities, { modify: true, send: false, multipleMailboxes: true })
  const { messages } = await snapshotFrom(adapter, null)
  assert.deepEqual([find(messages, 'a').bulk, find(messages, 'b').bulk], [true, false])
})

await check('L03 labels: a message in zero mailboxes is still listed', async () => {
  const { adapter, box } = await open('labels', [mail('a'), mail('b', 'inbox', { mailboxes: [] })])
  box.removeFromMailbox('a', 'inbox')
  const { messages } = await snapshotFrom(adapter, null)
  assert.deepEqual(keys(messages), ['b', 'a'])
  assert.deepEqual([find(messages, 'a').mailboxes, find(messages, 'b').mailboxes], [[], []])
  assert.deepEqual(box.truth(), [
    { key: 'a', mailboxes: [], unread: true, flagged: false },
    { key: 'b', mailboxes: [], unread: true, flagged: false },
  ])
})

await check('L04 labels: changes is quiet when nothing happened and its cursor moves on', async () => {
  const { adapter, box } = await open('labels', [mail('a')])
  const { cursor } = await snapshotFrom(adapter, null)
  assertQuiet(await changesSince(adapter, cursor))
  box.deliver(mail('n'))
  const first = await changesSince(adapter, cursor)
  assert.deepEqual(keys(first.added), ['n'])
  assertQuiet(await changesSince(adapter, first.cursor))
})

await check('L05 labels: a delivered message is added with full facts', async () => {
  const { adapter, box } = await open('labels', [mail('a')])
  const { cursor, mailboxes } = await snapshotFrom(adapter, null)
  box.deliver(mail('n', 'work', { attachments: 1, replyTo: ['a'], flagged: true }))
  const set = await changesSince(adapter, cursor)
  assert.deepEqual([set.updated, set.removed, set.mailboxes], [[], [], null])
  const added = find(set.added, 'n')
  assert.equal(set.added.length, 1)
  assert.deepEqual(
    [added.messageId, added.references, added.hasAttachments, added.flagged, added.unread, added.preview],
    ['n@sim.test', ['a@sim.test'], true, true, true, 'Text of n'],
  )
  assert.deepEqual(boxNames(mailboxes, added), ['Work'])
})

await check('L06 labels: a flag change is updated with the new state', async () => {
  const { adapter, box } = await open('labels', [mail('a'), mail('b')])
  const { cursor, messages } = await snapshotFrom(adapter, null)
  box.setFlags('a', { flagged: true })
  const set = await changesSince(adapter, cursor)
  assert.deepEqual(set.updated, [{ ...stateOf(find(messages, 'a')), flagged: true }])
  assert.deepEqual([set.added, set.removed], [[], []])
})

await check('L07 labels: an expunged message is removed', async () => {
  const { adapter, box } = await open('labels', [mail('a'), mail('b')])
  const { cursor, messages } = await snapshotFrom(adapter, null)
  box.setFlags('a', { unread: false })
  box.expunge('a')
  const set = await changesSince(adapter, cursor)
  assert.deepEqual([set.added, set.updated, set.removed], [[], [], [find(messages, 'a').ref]])
})

await check('L08 labels: added then changed appears once, in added, with its current state', async () => {
  const { adapter, box } = await open('labels', [mail('a')])
  const { cursor, mailboxes } = await snapshotFrom(adapter, null)
  box.deliver(mail('n'))
  box.setFlags('n', { unread: false })
  box.addToMailbox('n', 'work')
  const set = await changesSince(adapter, cursor)
  assert.deepEqual([keys(set.added), set.updated, set.removed], [['n'], [], []])
  const added = find(set.added, 'n')
  assert.deepEqual([added.unread, boxNames(mailboxes, added)], [false, ['Inbox', 'Work']])
})

await check('L09 labels: mailboxes is the full list only when one was created', async () => {
  const { adapter, box } = await open('labels', [mail('a')])
  const { cursor } = await snapshotFrom(adapter, null)
  box.setFlags('a', { unread: false })
  const before = await changesSince(adapter, cursor)
  assert.equal(before.mailboxes, null)
  box.createMailbox({ key: 'new', name: 'New', role: null, parent: 'work' })
  const after = await changesSince(adapter, before.cursor)
  assert.deepEqual(
    after.mailboxes?.map((mailbox) => mailbox.name),
    ['Inbox', 'Archive', 'Work', 'New'],
  )
  assert.equal((await changesSince(adapter, after.cursor)).mailboxes, null)
})

await check('L10 labels: a ref never changes', async () => {
  const { adapter, box } = await open('labels', [mail('a')])
  const first = await snapshotFrom(adapter, null)
  const ref = find(first.messages, 'a').ref
  box.move('a', 'archive')
  box.addToMailbox('a', 'work')
  box.removeFromMailbox('a', 'archive')
  const set = await changesSince(adapter, first.cursor)
  assert.deepEqual([set.added, set.removed], [[], []])
  assert.deepEqual(set.updated, [{ ref, mailboxes: [boxRef(first.mailboxes, 'Work')], unread: true, flagged: false }])
  assert.equal(find((await snapshotFrom(adapter, null)).messages, 'a').ref, ref)
})

await check('L11 labels: apply adds and removes membership freely', async () => {
  const { adapter, box } = await open('labels', [mail('a'), mail('b', 'archive')])
  const { messages, mailboxes } = await snapshotFrom(adapter, null)
  const [inbox, archive, work] = ['Inbox', 'Archive', 'Work'].map((name) => boxRef(mailboxes, name))
  assert(inbox && archive && work)
  const refs = [find(messages, 'a').ref, find(messages, 'b').ref]
  const grown = await adapter.apply({ kind: 'mailboxes', refs, add: [work, archive], remove: [inbox] })
  assert.deepEqual(grown, { ok: true, kind: 'applied', moved: [] })
  assert.deepEqual(
    box.truth().map((message) => message.mailboxes),
    [
      ['archive', 'work'],
      ['archive', 'work'],
    ],
  )
  const emptied = await adapter.apply({ kind: 'mailboxes', refs, add: [], remove: [work, archive] })
  assert.deepEqual(emptied, { ok: true, kind: 'applied', moved: [] })
  assert.deepEqual(
    box.truth().map((message) => message.mailboxes),
    [[], []],
  )
})

await check('L12 labels: expireCursors expires every older cursor', async () => {
  const { adapter, box } = await open('labels', [mail('a')])
  const first = await snapshotFrom(adapter, null)
  const later = await changesSince(adapter, first.cursor)
  box.expireCursors()
  assert.deepEqual(await adapter.changes(first.cursor), { ok: true, kind: 'cursor-expired' })
  assert.deepEqual(await adapter.changes(later.cursor), { ok: true, kind: 'cursor-expired' })
  const second = await snapshotFrom(adapter, null)
  assert.equal(find(second.messages, 'a').ref, find(first.messages, 'a').ref)
  box.deliver(mail('n'))
  box.deliver(mail('o'))
  assert.deepEqual(keys((await changesSince(adapter, second.cursor)).added), ['n', 'o'])
  assert.deepEqual(await adapter.changes(first.cursor), { ok: true, kind: 'cursor-expired' })
})

await check('L13 labels: an old valid cursor replays everything since its position', async () => {
  const { adapter, box } = await open('labels', [mail('a')])
  const { cursor } = await snapshotFrom(adapter, null)
  box.deliver(mail('n'))
  const first = await changesSince(adapter, cursor)
  box.deliver(mail('o'))
  assert.deepEqual(keys((await changesSince(adapter, first.cursor)).added), ['o'])
  assert.deepEqual(keys((await changesSince(adapter, cursor)).added), ['n', 'o'])
})

await check('L14 labels: control move leaves the message in exactly one mailbox', async () => {
  const { box } = await open('labels', [mail('a', 'inbox', { mailboxes: ['work', 'inbox'] })])
  assert.deepEqual(box.truth(), [{ key: 'a', mailboxes: ['inbox', 'work'], unread: true, flagged: false }])
  box.move('a', 'archive')
  assert.deepEqual(box.truth(), [{ key: 'a', mailboxes: ['archive'], unread: true, flagged: false }])
})

// ---------------------------------------------------------------- folders

await check('F01 folders: capabilities, null bulk and one mailbox per message', async () => {
  const { adapter } = await open('folders', [mail('a', 'inbox', { bulk: true }), mail('b', 'archive')])
  assert.deepEqual(adapter.capabilities, { modify: true, send: false, multipleMailboxes: false })
  const { messages, mailboxes } = await snapshotFrom(adapter, null)
  assert.deepEqual(keys(messages), ['b', 'a'])
  assert.deepEqual(
    messages.map((message) => [message.bulk, boxNames(mailboxes, message)]),
    [
      [null, ['Archive']],
      [null, ['Inbox']],
    ],
  )
})

await check('F02 folders: zero or two mailboxes on a message throws', async () => {
  const provider = await start()
  const two = mail('x', 'inbox', { mailboxes: ['inbox', 'work'] })
  const none = mail('y', 'inbox', { mailboxes: [] })
  assert.throws(() => provider.createMailbox('folders', seedOf([two])))
  assert.throws(() => provider.createMailbox('folders', seedOf([none], { address: 'b@sim.test' })))
  const box = provider.createMailbox('folders', seedOf([mail('a')], { address: 'c@sim.test' }))
  assert.throws(() => box.deliver(two))
  assert.throws(() => box.deliver(none))
  assert.deepEqual(box.truth(), [{ key: 'a', mailboxes: ['inbox'], unread: true, flagged: false }])
})

await check('F03 folders: addToMailbox and removeFromMailbox throw', async () => {
  const { box } = await open('folders', [mail('a')])
  assert.throws(() => box.addToMailbox('a', 'work'))
  assert.throws(() => box.removeFromMailbox('a', 'inbox'))
  assert.deepEqual(box.truth(), [{ key: 'a', mailboxes: ['inbox'], unread: true, flagged: false }])
})

await check('F04 folders: the diff reports added, removed and updated numbers only', async () => {
  const { adapter, box } = await open('folders', [mail('a'), mail('b'), mail('c'), mail('d', 'archive')])
  const { cursor, messages } = await snapshotFrom(adapter, null)
  box.deliver(mail('n'))
  box.expunge('a')
  box.setFlags('b', { unread: false })
  const set = await changesSince(adapter, cursor)
  assert.deepEqual(keys(set.added), ['n'])
  assert.equal(find(set.added, 'n').messageId, 'n@sim.test')
  assert.deepEqual(set.removed, [find(messages, 'a').ref])
  assert.deepEqual(set.updated, [{ ...stateOf(find(messages, 'b')), unread: false }])
  assert.equal(set.mailboxes, null)
})

await check('F05 folders: a flag change is not reported again by a later cursor', async () => {
  const { adapter, box } = await open('folders', [mail('a'), mail('b')])
  const { cursor } = await snapshotFrom(adapter, null)
  assertQuiet(await changesSince(adapter, cursor))
  box.setFlags('a', { flagged: true })
  const first = await changesSince(adapter, cursor)
  assert.equal(first.updated.length, 1)
  assertQuiet(await changesSince(adapter, first.cursor))
  box.setFlags('b', { flagged: true })
  assert.equal((await changesSince(adapter, first.cursor)).updated.length, 1)
  assert.equal((await changesSince(adapter, cursor)).updated.length, 2)
})

await check('F06 folders: a control move is one removed ref and one added ref', async () => {
  const { adapter, box } = await open('folders', [mail('a'), mail('b')])
  const { cursor, messages, mailboxes } = await snapshotFrom(adapter, null)
  const old = find(messages, 'a').ref
  box.move('a', 'archive')
  const set = await changesSince(adapter, cursor)
  assert.deepEqual([keys(set.added), set.removed, set.updated], [['a'], [old], []])
  const moved = find(set.added, 'a')
  assert.notEqual(moved.ref, old)
  assert.deepEqual(boxNames(mailboxes, moved), ['Archive'])
  assert.deepEqual(await adapter.body(old), { ok: true, kind: 'gone' })
  const body = await adapter.body(moved.ref)
  assert(body.ok && body.kind === 'body')
  assert.equal(body.body.text, 'Text of a')
  assert.deepEqual(box.truth()[0], { key: 'a', mailboxes: ['archive'], unread: true, flagged: false })
})

await check('F07 folders: apply move lists the ref pair in moved and echoes it', async () => {
  const { adapter, box } = await open('folders', [mail('a'), mail('b'), mail('c', 'archive')])
  const { cursor, messages, mailboxes } = await snapshotFrom(adapter, null)
  const [a, b, c] = ['a', 'b', 'c'].map((key) => find(messages, key).ref)
  assert(a && b && c)
  const move = { add: [boxRef(mailboxes, 'Archive')], remove: [boxRef(mailboxes, 'Inbox')] }
  const result = await adapter.apply({ kind: 'mailboxes', refs: [a, b, c], ...move })
  assert(result.ok && result.kind === 'applied', 'the move was not applied')
  assert.deepEqual(
    result.moved.map((pair) => pair.from),
    [a, b],
  )
  const set = await changesSince(adapter, cursor)
  assert.deepEqual([...set.removed].toSorted(), [a, b].toSorted())
  assert.deepEqual(
    set.added.map((message) => [message.subject, message.ref]),
    [
      ['a', result.moved[0]?.to],
      ['b', result.moved[1]?.to],
    ],
  )
  assert.deepEqual(
    box.truth().map((message) => message.mailboxes),
    [['archive'], ['archive'], ['archive']],
  )
})

await check('F08 folders: apply mailboxes that is not a move is not-supported', async () => {
  const { adapter, box } = await open('folders', [mail('a')])
  const { messages, mailboxes } = await snapshotFrom(adapter, null)
  const refs = [find(messages, 'a').ref]
  const [inbox, archive, work] = ['Inbox', 'Archive', 'Work'].map((name) => boxRef(mailboxes, name))
  assert(inbox && archive && work)
  const refused = { ok: true, kind: 'refused', reason: 'not-supported' }
  assert.deepEqual(await adapter.apply({ kind: 'mailboxes', refs, add: [archive, work], remove: [inbox] }), refused)
  assert.deepEqual(await adapter.apply({ kind: 'mailboxes', refs, add: [], remove: [inbox] }), refused)
  assert.deepEqual(await adapter.apply({ kind: 'mailboxes', refs, add: [archive], remove: [] }), refused)
  assert.deepEqual(box.truth(), [{ key: 'a', mailboxes: ['inbox'], unread: true, flagged: false }])
})

await check('F09 folders: a mailbox created since the cursor is listed and its messages are added', async () => {
  const { adapter, box } = await open('folders', [mail('a')])
  const { cursor } = await snapshotFrom(adapter, null)
  box.createMailbox({ key: 'new', name: 'New', role: null })
  box.deliver(mail('n', 'new'))
  const set = await changesSince(adapter, cursor)
  assert.deepEqual(
    set.mailboxes?.map((mailbox) => mailbox.name),
    ['Inbox', 'Archive', 'Work', 'New'],
  )
  assert.deepEqual(keys(set.added), ['n'])
  assert.deepEqual(boxNames(set.mailboxes ?? [], find(set.added, 'n')), ['New'])
  assertQuiet(await changesSince(adapter, set.cursor))
})

await check('F10 folders: expireCursors changes every ref and expires older cursors', async () => {
  const { adapter, box } = await open('folders', [mail('a'), mail('b', 'archive')])
  const first = await snapshotFrom(adapter, null)
  box.expireCursors()
  assert.deepEqual(await adapter.changes(first.cursor), { ok: true, kind: 'cursor-expired' })
  const second = await snapshotFrom(adapter, null)
  assert.deepEqual(keys(second.messages), ['b', 'a'])
  const oldRefs = first.messages.map((message) => message.ref)
  for (const message of second.messages) assert(!oldRefs.includes(message.ref), `${message.subject} kept its ref`)
  for (const ref of oldRefs) assert.deepEqual(await adapter.body(ref), { ok: true, kind: 'gone' })
  assert.deepEqual(await adapter.apply({ kind: 'flags', refs: oldRefs, unread: false }), {
    ok: true,
    kind: 'refused',
    reason: 'unknown-target',
  })
  assertQuiet(await changesSince(adapter, second.cursor))
})

await check('F11 folders: a number is never reused, so an old ref never names a new message', async () => {
  const { adapter, box } = await open('folders', [mail('a'), mail('b')])
  const first = await snapshotFrom(adapter, null)
  const old = find(first.messages, 'b').ref
  box.expunge('b')
  box.deliver(mail('n'))
  const second = await snapshotFrom(adapter, null)
  assert.notEqual(find(second.messages, 'n').ref, old)
  assert.deepEqual(await adapter.body(old), { ok: true, kind: 'gone' })
})

// ---------------------------------------------------------------- both dialects

await both('B01 messageId, references and addresses', async (dialect) => {
  const ann = { name: 'Ann', address: 'ann@sim.test' }
  const { adapter } = await open(dialect, [
    mail('a', 'inbox', { from: ann, cc: ['cc@sim.test', ann], messageId: '<custom@id>' }),
    mail('b', 'inbox', { replyTo: ['a'] }),
    mail('c', 'inbox', { replyTo: ['a', 'b'], sentAt: '2026-02-03T04:05:06Z' }),
  ])
  const { messages } = await snapshotFrom(adapter, null)
  const [a, b, c] = ['a', 'b', 'c'].map((key) => find(messages, key))
  assert(a && b && c)
  assert.deepEqual([a.messageId, b.messageId], ['custom@id', 'b@sim.test'])
  assert.deepEqual([a.references, b.references, c.references], [[], ['custom@id'], ['custom@id', 'b@sim.test']])
  assert.deepEqual([a.from, b.from], [ann, { name: null, address: 'ann@sim.test' }])
  assert.deepEqual([a.to, a.cc, b.cc], [[{ name: null, address }], [{ name: null, address: 'cc@sim.test' }, ann], []])
  assert.deepEqual([a.sentAt, c.sentAt], ['2026-01-01T00:00:00Z', '2026-02-03T04:05:06Z'])
})

await both('B02 preview and size', async (dialect) => {
  const text = `Hello   there\n> quoted line\n>> deeper\n\nsecond\tline ${'x'.repeat(300)}`
  const { adapter } = await open(dialect, [
    mail('a', 'inbox', { text }),
    mail('b', 'inbox', { text: 'héllo', html: '<p>é</p>' }),
  ])
  const { messages } = await snapshotFrom(adapter, null)
  const preview = find(messages, 'a').preview
  assert.equal(preview, `Hello there second line ${'x'.repeat(300)}`.slice(0, 200))
  assert.equal(preview.length, 200)
  assert.deepEqual([find(messages, 'a').size, find(messages, 'b').size], [Buffer.byteLength(text), 6 + 9])
})

await both('B03 headers, hasAttachments and flag defaults', async (dialect) => {
  const { adapter } = await open(dialect, [
    mail('a', 'inbox', { headers: { listUnsubscribe: true, precedence: 'bulk' }, attachments: 2, unread: false }),
    mail('b', 'inbox', { headers: { listId: true, autoSubmitted: 'auto-replied' }, flagged: true }),
    mail('c'),
  ])
  const { messages } = await snapshotFrom(adapter, null)
  const [a, b, c] = ['a', 'b', 'c'].map((key) => find(messages, key))
  assert(a && b && c)
  assert.deepEqual(a.headers, { listUnsubscribe: true, listId: false, precedence: 'bulk', autoSubmitted: '' })
  assert.deepEqual(b.headers, { listUnsubscribe: false, listId: true, precedence: '', autoSubmitted: 'auto-replied' })
  assert.deepEqual(c.headers, { listUnsubscribe: false, listId: false, precedence: '', autoSubmitted: '' })
  assert.deepEqual([a.hasAttachments, b.hasAttachments, c.hasAttachments], [true, false, false])
  assert.deepEqual(
    [a.unread, a.flagged, b.unread, b.flagged, c.unread, c.flagged],
    [false, false, true, true, true, false],
  )
})

await both('B04 body returns text, html and attachment entries', async (dialect) => {
  const { adapter } = await open(dialect, [mail('a', 'inbox', { html: '<b>x</b>', attachments: 2 }), mail('b')])
  const { messages } = await snapshotFrom(adapter, null)
  const file = { mime: 'application/octet-stream', size: 1000, inline: false }
  assert.deepEqual(await adapter.body(find(messages, 'a').ref), {
    ok: true,
    kind: 'body',
    body: {
      text: 'Text of a',
      html: '<b>x</b>',
      attachments: [
        { name: 'file-1.bin', ...file },
        { name: 'file-2.bin', ...file },
      ],
    },
  })
  assert.deepEqual(await adapter.body(find(messages, 'b').ref), {
    ok: true,
    kind: 'body',
    body: { text: 'Text of b', html: null, attachments: [] },
  })
})

await both('B05 body for an expunged ref answers gone', async (dialect) => {
  const { adapter, box } = await open(dialect, [mail('a'), mail('b')])
  const { messages } = await snapshotFrom(adapter, null)
  box.expunge('a')
  assert.deepEqual(await adapter.body(find(messages, 'a').ref), { ok: true, kind: 'gone' })
  const kept = await adapter.body(find(messages, 'b').ref)
  assert(kept.ok && kept.kind === 'body')
})

await both('B06 snapshot pages by pageSize and keeps the cursor for the last page', async (dialect) => {
  const five = ['a', 'b', 'c', 'd', 'e'].map((key) => mail(key))
  const { adapter } = await open(dialect, five, { pageSize: 2 })
  const first = await pageOf(adapter, null)
  assert.deepEqual([keys(first.messages), first.cursor, first.mailboxes.length], [['e', 'd'], null, 3])
  assert(first.next !== null)
  const second = await pageOf(adapter, first.next)
  assert.deepEqual([keys(second.messages), second.cursor, second.mailboxes.length], [['c', 'b'], null, 3])
  assert(second.next !== null)
  const third = await pageOf(adapter, second.next)
  assert.deepEqual([keys(third.messages), third.next, third.mailboxes.length], [['a'], null, 3])
  assert(third.cursor !== null)
  assertQuiet(await changesSince(adapter, third.cursor))
})

await both('B07 a delivery between pages is left to the next changes, never lost', async (dialect) => {
  const { adapter, box } = await open(dialect, [mail('a'), mail('b'), mail('c')], { pageSize: 2 })
  const first = await pageOf(adapter, null)
  assert(first.next !== null)
  box.deliver(mail('d'))
  const rest = await snapshotFrom(adapter, first.next)
  assert.deepEqual(keys([...first.messages, ...rest.messages]), ['c', 'b', 'a'])
  const set = await changesSince(adapter, rest.cursor)
  assert.deepEqual([keys(set.added), set.updated, set.removed], [['d'], [], []])
})

await both('B08 a flag change between pages is reported by the next changes', async (dialect) => {
  const { adapter, box } = await open(dialect, [mail('a'), mail('b'), mail('c')], { pageSize: 2 })
  const first = await pageOf(adapter, null)
  assert(first.next !== null)
  box.setFlags('c', { unread: false })
  const rest = await snapshotFrom(adapter, first.next)
  assert.deepEqual(keys(rest.messages), ['a'])
  const set = await changesSince(adapter, rest.cursor)
  assert.deepEqual(set.updated, [{ ...stateOf(find(first.messages, 'c')), unread: false }])
  assert.deepEqual([set.added, set.removed], [[], []])
})

await both('B09 an expunge between pages keeps paging and is reported as removed', async (dialect) => {
  const five = ['a', 'b', 'c', 'd', 'e'].map((key) => mail(key))
  const { adapter, box } = await open(dialect, five, { pageSize: 2 })
  const first = await pageOf(adapter, null)
  assert(first.next !== null)
  box.expunge('e')
  box.expunge('c')
  const rest = await snapshotFrom(adapter, first.next)
  assert.deepEqual(keys(rest.messages), ['b', 'a'])
  const set = await changesSince(adapter, rest.cursor)
  assert(set.removed.includes(find(first.messages, 'e').ref), 'the listed message is not reported as removed')
  assert.deepEqual([set.added, set.updated, set.removed.length], [[], [], 2])
})

await both('B10 apply flags sets given values and leaves undefined ones alone', async (dialect) => {
  const { adapter, box } = await open(dialect, [mail('a'), mail('b', 'inbox', { flagged: true })])
  const { messages } = await snapshotFrom(adapter, null)
  const refs = [find(messages, 'a').ref, find(messages, 'b').ref]
  assert.deepEqual(await adapter.apply({ kind: 'flags', refs, unread: false }), {
    ok: true,
    kind: 'applied',
    moved: [],
  })
  assert.deepEqual(
    box.truth().map((message) => [message.unread, message.flagged]),
    [
      [false, false],
      [false, true],
    ],
  )
  assert.deepEqual(await adapter.apply({ kind: 'flags', refs, flagged: false }), {
    ok: true,
    kind: 'applied',
    moved: [],
  })
  assert.deepEqual(
    box.truth().map((message) => [message.unread, message.flagged]),
    [
      [false, false],
      [false, false],
    ],
  )
})

await both("B11 the next changes echoes the core's own apply", async (dialect) => {
  const { adapter } = await open(dialect, [mail('a'), mail('b')])
  const { messages, cursor } = await snapshotFrom(adapter, null)
  const a = find(messages, 'a')
  await adapter.apply({ kind: 'flags', refs: [a.ref], unread: false, flagged: true })
  const set = await changesSince(adapter, cursor)
  assert.deepEqual(set.updated, [{ ...stateOf(a), unread: false, flagged: true }])
  assert.deepEqual([set.added, set.removed], [[], []])
})

await both('B12 apply skips refs that are gone', async (dialect) => {
  const { adapter, box } = await open(dialect, [mail('a'), mail('b')])
  const { messages } = await snapshotFrom(adapter, null)
  box.expunge('b')
  const refs = [find(messages, 'b').ref, find(messages, 'a').ref]
  assert.deepEqual(await adapter.apply({ kind: 'flags', refs, unread: false }), {
    ok: true,
    kind: 'applied',
    moved: [],
  })
  assert.deepEqual(box.truth(), [{ key: 'a', mailboxes: ['inbox'], unread: false, flagged: false }])
})

await both('B13 apply with only gone refs answers unknown-target', async (dialect) => {
  const { adapter, box } = await open(dialect, [mail('a'), mail('b')])
  const { messages } = await snapshotFrom(adapter, null)
  box.expunge('b')
  const unknown = { ok: true, kind: 'refused', reason: 'unknown-target' }
  assert.deepEqual(await adapter.apply({ kind: 'flags', refs: [find(messages, 'b').ref], unread: false }), unknown)
  assert.deepEqual(await adapter.apply({ kind: 'flags', refs: [], unread: false }), unknown)
  assert.deepEqual(box.truth(), [{ key: 'a', mailboxes: ['inbox'], unread: true, flagged: false }])
})

await both('B14 read-only: modify is false and apply answers not-permitted', async (dialect) => {
  const { adapter, box } = await open(dialect, [mail('a')], { canModify: false })
  assert.equal(adapter.capabilities.modify, false)
  const { messages, cursor } = await snapshotFrom(adapter, null)
  const result = await adapter.apply({ kind: 'flags', refs: [find(messages, 'a').ref], unread: false })
  assert.deepEqual(result, { ok: true, kind: 'refused', reason: 'not-permitted' })
  assert.deepEqual(box.truth(), [{ key: 'a', mailboxes: ['inbox'], unread: true, flagged: false }])
  assertQuiet(await changesSince(adapter, cursor))
})

await both('B15 refuseNextApply refuses once and changes nothing', async (dialect) => {
  const { adapter, box } = await open(dialect, [mail('a')])
  const { messages, cursor } = await snapshotFrom(adapter, null)
  const mutation: Mutation = { kind: 'flags', refs: [find(messages, 'a').ref], unread: false }
  box.refuseNextApply('conflict')
  assert.deepEqual(await adapter.apply(mutation), { ok: true, kind: 'refused', reason: 'conflict' })
  assert.deepEqual(box.truth(), [{ key: 'a', mailboxes: ['inbox'], unread: true, flagged: false }])
  assertQuiet(await changesSince(adapter, cursor))
  assert.deepEqual(await adapter.apply(mutation), { ok: true, kind: 'applied', moved: [] })
  box.refuseNextApply('refused-by-provider')
  assert.deepEqual(await adapter.apply(mutation), { ok: true, kind: 'refused', reason: 'refused-by-provider' })
  assert.equal(box.truth()[0]?.unread, false)
})

await both('B16 offline: every call answers offline, uncounted, with the truth untouched', async (dialect) => {
  const { adapter, box } = await open(dialect, [mail('a')])
  const { messages, cursor } = await snapshotFrom(adapter, null)
  const ref = find(messages, 'a').ref
  const counted = box.calls()
  box.setOffline(true)
  assert.deepEqual(await adapter.snapshot(null), offline)
  assert.deepEqual(await adapter.changes(cursor), offline)
  assert.deepEqual(await adapter.body(ref), offline)
  assert.deepEqual(await adapter.apply({ kind: 'flags', refs: [ref], unread: false }), offline)
  assert.deepEqual(box.calls(), counted)
  assert.deepEqual(box.truth(), [{ key: 'a', mailboxes: ['inbox'], unread: true, flagged: false }])
})

await both('B17 recovery: the same adapter and cursor work once back online', async (dialect) => {
  const { adapter, box } = await open(dialect, [mail('a')])
  const { messages, cursor } = await snapshotFrom(adapter, null)
  box.setOffline(true)
  box.deliver(mail('n'))
  assert.deepEqual(await adapter.changes(cursor), offline)
  box.setOffline(false)
  assert.deepEqual(keys((await changesSince(adapter, cursor)).added), ['n'])
  const ref = find(messages, 'a').ref
  assert.deepEqual(await adapter.apply({ kind: 'flags', refs: [ref], unread: false }), {
    ok: true,
    kind: 'applied',
    moved: [],
  })
})

await both('B18 calls() counts each method that reached the server', async (dialect) => {
  const { adapter, box } = await open(dialect, [mail('a'), mail('b'), mail('c')], { pageSize: 2 })
  assert.deepEqual(box.calls(), { snapshot: 0, changes: 0, body: 0, apply: 0 })
  const { messages, cursor } = await snapshotFrom(adapter, null)
  const ref = find(messages, 'a').ref
  await adapter.changes(cursor)
  await adapter.changes(cursor)
  await adapter.changes(cursor)
  await adapter.body(ref)
  box.refuseNextApply('conflict')
  await adapter.apply({ kind: 'flags', refs: [ref], unread: false })
  await adapter.apply({ kind: 'flags', refs: [ref], unread: false })
  assert.deepEqual(box.calls(), { snapshot: 2, changes: 3, body: 1, apply: 2 })
})

await both('B19 truth() is in delivery order without expunged messages', async (dialect) => {
  const { adapter, box } = await open(dialect, [mail('a'), mail('b', 'work'), mail('c', 'archive')])
  box.deliver(mail('d', 'archive', { unread: false, flagged: true }))
  box.expunge('b')
  box.move('a', 'work')
  const { messages } = await snapshotFrom(adapter, null)
  await adapter.apply({ kind: 'flags', refs: [find(messages, 'c').ref], flagged: true })
  assert.deepEqual(box.truth(), [
    { key: 'a', mailboxes: ['work'], unread: true, flagged: false },
    { key: 'c', mailboxes: ['archive'], unread: true, flagged: true },
    { key: 'd', mailboxes: ['archive'], unread: false, flagged: true },
  ])
  assert.deepEqual(keys(messages), ['d', 'c', 'a'])
})

await both("B20 a mailbox parent is the parent's ref", async (dialect) => {
  const nested = [...boxes, { key: 'sub', name: 'Sub', role: null, parent: 'work' }]
  const { adapter } = await open(dialect, [mail('a', 'sub')], { mailboxes: nested })
  const { mailboxes, messages } = await snapshotFrom(adapter, null)
  assert.equal(mailboxes.find((mailbox) => mailbox.name === 'Sub')?.parent, boxRef(mailboxes, 'Work'))
  assert.deepEqual(boxNames(mailboxes, find(messages, 'a')), ['Sub'])
})

await both('B21 concurrent calls on one adapter each get their own answer', async (dialect) => {
  const { adapter } = await open(dialect, [mail('a'), mail('b')])
  const { messages, cursor } = await snapshotFrom(adapter, null)
  const [page, set, body, applied] = await Promise.all([
    adapter.snapshot(null),
    adapter.changes(cursor),
    adapter.body(find(messages, 'b').ref),
    adapter.apply({ kind: 'flags', refs: [find(messages, 'a').ref], flagged: true }),
  ])
  assert(page.ok && set.ok && body.ok && applied.ok)
  assert.equal(page.messages.length, 2)
  assert.equal(set.kind, 'changes')
  assert(body.kind === 'body')
  assert.equal(body.body.text, 'Text of b')
  assert.equal(applied.kind, 'applied')
})

// ---------------------------------------------------------------- sign-in

await check('S01 the factories are sim-password then sim-oauth', async () => {
  const options = simAdapterFactories(socketPath).map((factory) => [factory.option.id, factory.option.method])
  assert.deepEqual(options, [
    ['sim-password', 'password'],
    ['sim-oauth', 'oauth'],
  ])
})

await both('S02 password sign-in answers the address, the label and a session', async (dialect) => {
  const provider = await start()
  provider.createMailbox(dialect, seedOf([mail('a')]))
  const connection = await signIn()
  assert(connection.ok, 'sign-in failed')
  assert.deepEqual(
    [connection.address, connection.providerLabel],
    [address, dialect === 'labels' ? 'Sim labels' : 'Sim folders'],
  )
  assert.equal(typeof connection.session, 'string')
  assert.deepEqual(keys((await snapshotFrom(connection.adapter, null)).messages), ['a'])
})

await check('S03 a wrong password answers wrong-password', async () => {
  const provider = await start()
  provider.createMailbox('labels', seedOf([]))
  assert.deepEqual(await signIn(address, 'nope'), { ok: false, failure: 'wrong-password' })
  assert.deepEqual(await signIn(address, ''), { ok: false, failure: 'wrong-password' })
})

await check('S04 an unknown address or a missing password answers wrong-password', async () => {
  const provider = await start()
  provider.createMailbox('labels', seedOf([]))
  assert.deepEqual(await signIn('nobody@sim.test', password), { ok: false, failure: 'wrong-password' })
  const [byPassword] = simAdapterFactories(socketPath)
  assert(byPassword)
  const bare = await byPassword.connect({ openUrl: () => {}, signal: new AbortController().signal })
  assert.deepEqual(track(bare), { ok: false, failure: 'wrong-password' })
})

await check('S05 password sign-in to an offline mailbox answers offline', async () => {
  const provider = await start()
  const box = provider.createMailbox('labels', seedOf([]))
  box.setOffline(true)
  assert.deepEqual(await signIn(), offline)
  box.setOffline(false)
  assert.equal((await signIn()).ok, true)
})

await both('S06 oauth opens sim://sign-in/<n> and approve signs in as that mailbox', async (dialect) => {
  const provider = await start()
  const box = provider.createMailbox(dialect, seedOf([mail('a')]))
  provider.createMailbox('labels', seedOf([mail('z')], { address: 'other@sim.test' }))
  const attempt = startOauth()
  const url = await attempt.url
  assert.match(url, /^sim:\/\/sign-in\/\d+$/)
  provider.approveSignIn(url, address)
  const connection = await attempt.result
  assert(connection.ok, 'oauth sign-in failed')
  assert.deepEqual(
    [connection.address, connection.providerLabel],
    [address, dialect === 'labels' ? 'Sim labels' : 'Sim folders'],
  )
  assert.deepEqual(keys((await snapshotFrom(connection.adapter, null)).messages), ['a'])
  assert.equal(box.calls().snapshot, 1)
})

await check('S07 each oauth attempt has its own url and its own answer', async () => {
  const provider = await start()
  provider.createMailbox('labels', seedOf([]))
  provider.createMailbox('folders', seedOf([], { address: 'other@sim.test' }))
  const first = startOauth()
  const second = startOauth()
  const [firstUrl, secondUrl] = await Promise.all([first.url, second.url])
  assert.notEqual(firstUrl, secondUrl)
  provider.denySignIn(firstUrl)
  provider.approveSignIn(secondUrl, 'other@sim.test')
  assert.deepEqual(await first.result, { ok: false, failure: 'denied' })
  const connection = await second.result
  assert(connection.ok)
  assert.deepEqual([connection.address, connection.providerLabel], ['other@sim.test', 'Sim folders'])
})

await check('S08 denySignIn answers denied', async () => {
  const provider = await start()
  provider.createMailbox('labels', seedOf([]))
  const attempt = startOauth()
  provider.denySignIn(await attempt.url)
  assert.deepEqual(await attempt.result, { ok: false, failure: 'denied' })
})

await check('S09 an aborted oauth attempt answers cancelled and stays forgotten', async () => {
  const provider = await start()
  provider.createMailbox('labels', seedOf([]))
  const controller = new AbortController()
  const attempt = startOauth(controller.signal)
  const url = await attempt.url
  controller.abort()
  assert.deepEqual(await attempt.result, { ok: false, failure: 'cancelled' })
  provider.approveSignIn(url, address)
  const next = startOauth()
  const nextUrl = await next.url
  assert.notEqual(nextUrl, url)
  provider.approveSignIn(nextUrl, address)
  assert.equal((await next.result).ok, true)
  let opened = false
  const [, oauth] = simAdapterFactories(socketPath)
  assert(oauth)
  const dead = await oauth.connect({ openUrl: () => void (opened = true), signal: AbortSignal.abort() })
  assert.deepEqual([track(dead), opened], [{ ok: false, failure: 'cancelled' }, false])
})

await check('S10 oauth approved for an offline mailbox answers offline', async () => {
  const provider = await start()
  const box = provider.createMailbox('labels', seedOf([]))
  box.setOffline(true)
  const attempt = startOauth()
  provider.approveSignIn(await attempt.url, address)
  assert.deepEqual(await attempt.result, offline)
})

await check('S11 two mailboxes in one provider stay separate', async () => {
  const provider = await start()
  const labels = provider.createMailbox('labels', seedOf([mail('a')]))
  const folders = provider.createMailbox('folders', seedOf([mail('z')], { address: 'other@sim.test', password: 'pw2' }))
  const mine = await signIn()
  const theirs = await signIn('other@sim.test', 'pw2')
  assert(mine.ok && theirs.ok)
  assert.deepEqual([mine.providerLabel, theirs.providerLabel], ['Sim labels', 'Sim folders'])
  assert.deepEqual(await signIn('other@sim.test', password), { ok: false, failure: 'wrong-password' })
  labels.deliver(mail('n'))
  folders.setOffline(true)
  assert.deepEqual(keys((await snapshotFrom(mine.adapter, null)).messages), ['n', 'a'])
  assert.deepEqual(await theirs.adapter.snapshot(null), offline)
  folders.setOffline(false)
  assert.deepEqual(keys((await snapshotFrom(theirs.adapter, null)).messages), ['z'])
  assert.deepEqual([labels.calls().snapshot, folders.calls().snapshot], [1, 1])
  assert.deepEqual(
    [labels.address, labels.dialect, folders.address, folders.dialect],
    [address, 'labels', 'other@sim.test', 'folders'],
  )
})

// ---------------------------------------------------------------- connection

await check('C01 with no socket, sign-in and adapter calls answer offline', async () => {
  assert.deepEqual(await signIn(), offline)
  let opened = false
  const [byPassword, oauth] = simAdapterFactories(socketPath)
  assert(byPassword && oauth)
  const attempt = await oauth.connect({ openUrl: () => void (opened = true), signal: new AbortController().signal })
  assert.deepEqual([track(attempt), opened], [offline, false])
  const provider = await start()
  provider.createMailbox('labels', seedOf([mail('a')]))
  const connection = await signIn()
  assert(connection.ok)
  const { messages, cursor } = await snapshotFrom(connection.adapter, null)
  await provider.close()
  const ref = find(messages, 'a').ref
  for (const adapter of [
    connection.adapter,
    track({ ok: true, adapter: byPassword.resume(connection.session) }).adapter,
  ]) {
    assert.deepEqual(await adapter.snapshot(null), offline)
    assert.deepEqual(await adapter.changes(cursor), offline)
    assert.deepEqual(await adapter.body(ref), offline)
    assert.deepEqual(await adapter.apply({ kind: 'flags', refs: [ref], unread: false }), offline)
  }
})

await both('C02 resume reaches the same mailbox without the password', async (dialect) => {
  const { adapter, box, session } = await open(dialect, [mail('a')], { canModify: false })
  const { cursor } = await snapshotFrom(adapter, null)
  await adapter.close()
  assert(!session.includes(password), 'the session holds the password')
  for (const factory of simAdapterFactories(socketPath)) {
    const resumed = track({ ok: true, adapter: factory.resume(session) }).adapter
    assert.deepEqual(resumed.capabilities, { modify: false, send: false, multipleMailboxes: dialect === 'labels' })
    box.deliver(mail(`n-${factory.option.id}`))
    const set = await changesSince(resumed, cursor)
    assert.equal(set.added.at(-1)?.subject, `n-${factory.option.id}`)
    await resumed.close()
  }
  assert.deepEqual(box.calls(), { snapshot: 1, changes: 2, body: 0, apply: 0 })
})

await check('C03 resume connects lazily, on first use', async () => {
  const first = await open('labels', [mail('a')])
  await first.provider.close()
  const [byPassword] = simAdapterFactories(socketPath)
  assert(byPassword)
  const before = openPipes()
  const resumed = track({ ok: true, adapter: byPassword.resume(first.session) }).adapter
  assert.equal(openPipes(), before, 'resume opened a socket before its first call')
  const provider = await start()
  const box = provider.createMailbox('labels', seedOf([mail('a'), mail('b')]))
  assert.deepEqual(box.calls(), { snapshot: 0, changes: 0, body: 0, apply: 0 })
  assert.deepEqual(keys((await snapshotFrom(resumed, null)).messages), ['b', 'a'])
})

await both('C04 an adapter recovers after the provider restarts on the same socket', async (dialect) => {
  const first = await open(dialect, [mail('a')])
  await snapshotFrom(first.adapter, null)
  await first.provider.close()
  assert.deepEqual(await first.adapter.snapshot(null), offline)
  const provider = await start()
  assert.deepEqual(await first.adapter.snapshot(null), { ok: false, failure: 'needs-sign-in' })
  const box = provider.createMailbox(dialect, seedOf([mail('a'), mail('b')]))
  assert.deepEqual(keys((await snapshotFrom(first.adapter, null)).messages), ['b', 'a'])
  assert.equal(box.calls().snapshot, 1)
})

await check('C05 a closed adapter no longer reaches the server', async () => {
  const { adapter, box } = await open('labels', [mail('a')])
  const { cursor } = await snapshotFrom(adapter, null)
  const counted = box.calls()
  const before = openPipes()
  await adapter.close()
  assert(openPipes() < before, 'close left the socket open')
  await adapter.close()
  assert.deepEqual(await adapter.snapshot(null), offline)
  assert.deepEqual(await adapter.changes(cursor), offline)
  assert.deepEqual(box.calls(), counted)
})

await check('C06 provider close removes the socket file and stops the server', async () => {
  const { provider } = await open('labels', [mail('a')])
  assert(existsSync(socketPath), 'the socket file was never there')
  await provider.close()
  assert(!existsSync(socketPath), 'the socket file is still there')
  assert.deepEqual(await signIn(), offline)
})

await both('H01 a held body call waits, then answers from the truth at release', async (dialect) => {
  const { adapter, box } = await open(dialect, [mail('a'), mail('b')])
  const { messages } = await snapshotFrom(adapter, null)
  box.holdBodies()
  let answered = false
  const kept = adapter.body(find(messages, 'a').ref).then((result) => ((answered = true), result))
  const gone = adapter.body(find(messages, 'b').ref)
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(answered, false, 'a held body call was answered before release')
  box.expunge('b')
  box.releaseBodies()
  const first = await kept
  assert(first.ok && first.kind === 'body', 'the kept message has no body')
  assert.equal(first.body.text, 'Text of a')
  assert.deepEqual(await gone, { ok: true, kind: 'gone' }, 'a message expunged during the hold is not gone')
  assert.equal(box.calls().body, 2)
})

await both('H03 a held apply call waits and changes nothing, then applies at release', async (dialect) => {
  const { adapter, box } = await open(dialect, [mail('a')])
  const { messages } = await snapshotFrom(adapter, null)
  box.holdApplies()
  let held = false
  const heldNow = box.applyHeld().then(() => (held = true))
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(held, false, 'applyHeld resolved before any apply call was held')
  let answered = false
  const outcome = adapter
    .apply({ kind: 'flags', refs: [find(messages, 'a').ref], unread: false })
    .then((result) => ((answered = true), result))
  await heldNow
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(answered, false, 'a held apply call was answered before release')
  assert.equal(box.truth()[0]?.unread, true, 'a held apply call changed the mailbox before release')
  box.releaseApplies()
  const released = await outcome
  assert(released.ok && released.kind === 'applied', 'the released apply call did not apply')
  assert.equal(box.truth()[0]?.unread, false, 'the released apply call did not change the mailbox')
  assert.equal(box.calls().apply, 1)
})

await both('H02 handedOut lists every opaque string the core got, and no facts', async (dialect) => {
  const { adapter, box, provider, session } = await open(dialect, [mail('a'), mail('b')], { pageSize: 1 })
  const first = await pageOf(adapter, null)
  assert(first.next !== null, 'pageSize 1 gave one page')
  const { messages, mailboxes, cursor } = await snapshotFrom(adapter, null)
  box.move('a', 'work')
  const set = await changesSince(adapter, cursor)
  const opaque = provider.handedOut()
  const expected = [
    session,
    first.next,
    cursor,
    set.cursor,
    ...messages.map((message) => message.ref),
    ...messages.flatMap((message) => message.mailboxes),
    ...mailboxes.map((mailbox) => mailbox.ref),
    ...set.added.map((message) => message.ref),
    ...set.updated.map((state) => state.ref),
    ...set.removed,
  ]
  for (const value of expected) assert(opaque.has(value), `handedOut misses ${value}`)
  for (const fact of [address, 'a', 'Text of a', 'ann@sim.test', 'Inbox', 'Work'])
    assert(!opaque.has(fact), `handedOut lists the fact ${fact}`)
})

console.log(`\n${passed} passed, ${failed} failed`)
assert(!existsSync(socketPath), 'the socket file is still there')
process.exitCode = failed === 0 ? 0 : 1
