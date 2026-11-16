// Self-check for sending at the sim provider. Run from the repo root:
//   node packages/sim-provider/src/selfcheck-send.ts
//
// Every way sending at this sim provider could be wrong. Each line has one check below with
// the same id. An "X" line runs once per dialect.
//
//   X01 a sent copy is not filed read in Sent, or its facts or body differ from the message's headers and parts
//   X02 the next changes misses the copy, reports it under another ref, or reports it twice
//   X03 find misses a copy with that Message-ID, or names one it does not hold
//   X04 refuseNextSend does not refuse, files a copy, or refuses more than once
//   X05 read-only: send is offered, or files a copy
//   X06 offline: send answers something else, is counted, or files a copy
//   X07 a held send is answered or files a copy before release
//   X08 sent() misses a Cc or Bcc recipient, or keeps another raw message than the one sent
//   X09 a mailbox with no Sent mailbox files the copy somewhere else
//   X10 a message with a line over RFC 5322's 998 characters is filed
//   X11 a send whose socket drops after the request went out answers offline, which lets the
//       core send it again, or one that never reached a socket answers anything but offline
//   M01 folded headers, Q and B encoded words, quoted names or a quoted-printable part read wrong
//   M02 withoutBcc keeps the Bcc header, loses its addresses, or touches the body

import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Adapter, Outgoing, RemoteMessage } from './adapter.ts'
import { simAdapterFactories } from './client.ts'
import type { Dialect, Seed } from './contract.ts'
import { readSent, withoutBcc } from './sent.ts'
import { startSimProvider } from './server.ts'

const socketPath = join(tmpdir(), `letterbox-sim-selfcheck-send-${process.pid}.sock`)
const address = 'me@sim.test'
const password = 'hunter2'

const seed = (extra: Partial<Seed> = {}): Seed => ({
  address,
  password,
  mailboxes: [
    { key: 'inbox', name: 'Inbox', role: 'inbox' },
    { key: 'sent', name: 'Sent', role: 'sent' },
  ],
  messages: [
    {
      key: 'ask',
      mailboxes: ['inbox'],
      from: 'ann@sim.test',
      to: [address],
      subject: 'Lunch?',
      text: 'Free on Friday?',
      sentAt: '2026-01-01T00:00:00.000Z',
    },
  ],
  ...extra,
})

const b64 = (text: string) => Buffer.from(text).toString('base64')

/** A reply as the core writes one: folded, encoded, multipart. */
const REPLY = [
  'From: me@sim.test',
  'To: ann@sim.test',
  'Cc: cy@sim.test,\r\n dee@sim.test',
  `Subject: =?UTF-8?B?${b64('Re: Lunch? ')}?=\r\n =?UTF-8?B?${b64('Ja, gern ☕')}?=`,
  'Date: Thu, 01 Jan 2026 10:00:05 +0000',
  'Message-ID: <reply-1@sim.test>',
  'In-Reply-To: <ask@sim.test>',
  'References: <ask@sim.test>',
  'MIME-Version: 1.0',
  'Content-Type: multipart/alternative; boundary="=_b"',
  '',
  '--=_b',
  'Content-Type: text/plain; charset=UTF-8',
  'Content-Transfer-Encoding: base64',
  '',
  b64('Yes.\r\n> Free on Friday?\r\nNoon works.'),
  '--=_b',
  'Content-Type: text/html; charset=UTF-8',
  'Content-Transfer-Encoding: base64',
  '',
  b64('<p>Yes.</p>'),
  '--=_b--',
  '',
].join('\r\n')

const outgoing = (extra: Partial<Outgoing> = {}): Outgoing => ({
  raw: REPLY,
  bcc: ['eve@sim.test'],
  messageId: 'reply-1@sim.test',
  replyTo: null,
  ...extra,
})

let passed = 0
let failed = 0
let cleanups: (() => Promise<void>)[] = []

/** Runs one check once per dialect, prints PASS or FAIL, then closes whatever it opened. */
const check = async (name: string, dialects: Dialect[], run: (dialect: Dialect) => Promise<void>) => {
  for (const dialect of dialects) {
    cleanups = []
    let problem: string | null = null
    try {
      await run(dialect)
    } catch (thrown) {
      problem = thrown instanceof Error ? thrown.message : String(thrown)
    }
    for (const cleanup of cleanups.toReversed()) await cleanup().catch(() => {})
    rmSync(socketPath, { force: true })
    if (problem === null) passed += 1
    else failed += 1
    const label = `${name} [${dialect}]`
    console.log(problem === null ? `PASS ${label}` : `FAIL ${label}\n       ${problem}`)
  }
}

const BOTH: Dialect[] = ['labels', 'folders']

/** Starts a provider with one seeded mailbox, signs in by password and takes its first snapshot. */
const open = async (dialect: Dialect, extra: Partial<Seed> = {}) => {
  const provider = await startSimProvider(socketPath)
  cleanups.push(() => provider.close())
  const box = provider.createMailbox(dialect, seed(extra))
  const [byPassword] = simAdapterFactories(socketPath)
  assert(byPassword, 'no password factory')
  const signal = new AbortController().signal
  const connection = await byPassword.connect({ password: { username: address, password }, openUrl: () => {}, signal })
  assert(connection.ok, 'password sign-in failed')
  const adapter: Adapter = connection.adapter
  cleanups.push(() => adapter.close())
  const page = await adapter.snapshot(null)
  assert(page.ok && page.cursor !== null, 'the first snapshot did not answer with a cursor')
  return { provider, box, adapter, cursor: page.cursor, mailboxes: page.mailboxes }
}

/** Sends and insists the provider took it. */
const sent = async (adapter: Adapter, message = outgoing()) => {
  const result = await adapter.send(message)
  assert(result.ok && result.kind === 'sent', `send answered ${JSON.stringify(result)}`)
  return result.ref
}

const subjects = (messages: RemoteMessage[]) => messages.map((message) => message.subject)

await check('X01 a sent copy is filed read in Sent with the facts and body of the message', BOTH, async (dialect) => {
  const { box, adapter, mailboxes } = await open(dialect)
  const ref = await sent(adapter)
  const page = await adapter.snapshot(null)
  assert(page.ok)
  const copy = page.messages.find((message) => message.ref === ref)
  assert(copy, 'the snapshot does not list the copy')
  const sentRef = mailboxes.find((mailbox) => mailbox.role === 'sent')?.ref
  assert.deepEqual([copy.mailboxes, copy.unread, copy.flagged], [[sentRef], false, false])
  assert.deepEqual(
    [copy.messageId, copy.references, copy.subject, copy.sentAt, copy.size],
    [
      'reply-1@sim.test',
      ['ask@sim.test'],
      'Re: Lunch? Ja, gern ☕',
      '2026-01-01T10:00:05.000Z',
      Buffer.byteLength(REPLY),
    ],
  )
  assert.deepEqual(
    [copy.from, copy.to.map((to) => to.address), copy.cc.map((cc) => cc.address)],
    [{ name: null, address }, ['ann@sim.test'], ['cy@sim.test', 'dee@sim.test']],
  )
  assert.equal(copy.preview, 'Yes. Noon works.')
  assert.equal(copy.bulk, dialect === 'labels' ? false : null)
  const body = await adapter.body(ref)
  assert(body.ok && body.kind === 'body')
  assert.deepEqual(body.body, { text: 'Yes.\n> Free on Friday?\nNoon works.', html: '<p>Yes.</p>', attachments: [] })
  assert.equal(box.truth().find((message) => message.key === 'sent-1')?.mailboxes[0], 'sent')
})

await check('X02 the next changes reports the copy once, under the ref send answered', BOTH, async (dialect) => {
  const { adapter, cursor } = await open(dialect)
  const ref = await sent(adapter)
  const set = await adapter.changes(cursor)
  assert(set.ok && set.kind === 'changes')
  assert.deepEqual([set.added.map((message) => message.ref), set.removed], [[ref], []])
  const again = await adapter.changes(set.cursor)
  assert(again.ok && again.kind === 'changes')
  assert.deepEqual(again.added, [], 'the copy was reported again')
})

await check('X03 find answers the copy with that Message-ID, or null', BOTH, async (dialect) => {
  const { box, adapter } = await open(dialect)
  assert.deepEqual(await adapter.find('reply-1@sim.test'), { ok: true, ref: null })
  const ref = await sent(adapter)
  assert.deepEqual(await adapter.find('reply-1@sim.test'), { ok: true, ref })
  assert.deepEqual([box.sent().length, box.calls().find], [1, 2])
})

await check('X04 refuseNextSend refuses once and files nothing', BOTH, async (dialect) => {
  const { box, adapter } = await open(dialect)
  box.refuseNextSend('refused-by-provider')
  assert.deepEqual(await adapter.send(outgoing()), { ok: true, kind: 'refused', reason: 'refused-by-provider' })
  assert.deepEqual(box.sent(), [])
  await sent(adapter)
  assert.equal(box.sent().length, 1)
})

await check('X05 read-only: send is not offered and answers not-permitted', BOTH, async (dialect) => {
  const { box, adapter } = await open(dialect, { canModify: false })
  assert.equal(adapter.capabilities.send, false)
  assert.deepEqual(await adapter.send(outgoing()), { ok: true, kind: 'refused', reason: 'not-permitted' })
  assert.deepEqual(box.sent(), [])
})

await check('X06 offline: send answers offline, uncounted, and files nothing', BOTH, async (dialect) => {
  const { box, adapter } = await open(dialect)
  box.setOffline(true)
  assert.deepEqual(await adapter.send(outgoing()), { ok: false, failure: 'offline' })
  box.setOffline(false)
  assert.deepEqual([box.sent(), box.calls().send], [[], 0])
})

await check('X07 a held send files nothing until release', BOTH, async (dialect) => {
  const { box, adapter } = await open(dialect)
  box.holdSends()
  let answered = false
  const result = adapter.send(outgoing()).then((answer) => ((answered = true), answer))
  await box.sendHeld()
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(answered, false, 'a held send was answered before release')
  assert.deepEqual(box.sent(), [])
  box.releaseSends()
  assert((await result).ok)
  assert.equal(box.sent().length, 1)
})

await check('X08 sent() lists To, Cc and Bcc as recipients and the raw message as sent', BOTH, async (dialect) => {
  const { box, adapter } = await open(dialect)
  await sent(adapter)
  assert.deepEqual(box.sent(), [
    { key: 'sent-1', recipients: ['ann@sim.test', 'cy@sim.test', 'dee@sim.test', 'eve@sim.test'], raw: REPLY },
  ])
})

await check('X09 a mailbox with no Sent mailbox answers not-supported', BOTH, async (dialect) => {
  const { box, adapter } = await open(dialect, { mailboxes: [{ key: 'inbox', name: 'Inbox', role: 'inbox' }] })
  assert.deepEqual(await adapter.send(outgoing()), { ok: true, kind: 'refused', reason: 'not-supported' })
  assert.deepEqual(subjects(await adapter.snapshot(null).then((page) => (page.ok ? page.messages : []))), ['Lunch?'])
  assert.deepEqual(box.sent(), [])
})

await check('M01 headers, encoded words, names and quoted-printable read right', ['labels'], async () => {
  const raw = [
    'From: "Ann, A." <ann@sim.test>',
    'To: =?UTF-8?Q?J=C3=BCrgen_K?= <jk@sim.test>, plain@sim.test',
    'Subject: a long subject that was\r\n folded once',
    'Date: Thu, 01 Jan 2026 10:00:05 +0000',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    'Gr=C3=BC=C3=9Fe, a soft =\r\nbreak.',
  ].join('\r\n')
  const { facts, body } = readSent(raw, null)
  assert.deepEqual(facts.from, { name: 'Ann, A.', address: 'ann@sim.test' })
  assert.deepEqual(facts.to, [
    { name: 'Jürgen K', address: 'jk@sim.test' },
    { name: null, address: 'plain@sim.test' },
  ])
  assert.equal(facts.subject, 'a long subject that was folded once')
  assert.deepEqual([facts.messageId, facts.references], [null, []])
  assert.deepEqual(body, { text: 'Grüße, a soft break.', html: null, attachments: [] })
})

await check('M02 withoutBcc takes out the header and keeps its addresses', ['labels'], async () => {
  const raw = 'Bcc: eve@sim.test,\r\n fay@sim.test\r\nFrom: me@sim.test\r\nSubject: x\r\n\r\nBcc: not a header\r\n'
  assert.deepEqual(withoutBcc(raw), {
    raw: 'From: me@sim.test\r\nSubject: x\r\n\r\nBcc: not a header\r\n',
    bcc: ['eve@sim.test', 'fay@sim.test'],
  })
})

await check('X10 a message with a line over 998 characters is refused', BOTH, async (dialect) => {
  const { box, adapter } = await open(dialect)
  const raw = REPLY.replace('Subject: ', `Subject: ${'x'.repeat(1000)} `)
  assert.deepEqual(await adapter.send(outgoing({ raw })), { ok: true, kind: 'refused', reason: 'refused-by-provider' })
  assert.deepEqual(box.sent(), [])
})

await check('X11 a dropped answer is unconfirmed, and no socket at all is offline', BOTH, async (dialect) => {
  const { box, adapter, provider } = await open(dialect)
  box.holdSends()
  const answer = adapter.send(outgoing())
  await box.sendHeld()
  await provider.close()
  assert.deepEqual(await answer, { ok: true, kind: 'unconfirmed' })
  assert.deepEqual(await adapter.send(outgoing()), { ok: false, failure: 'offline' })
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exitCode = failed === 0 ? 0 : 1
