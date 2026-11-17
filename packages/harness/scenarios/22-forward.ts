// Forwarding: a UI names the message it forwards, and the core writes the rest. The original's
// text follows the user's under a "Forwarded message" block, and its files go along with their
// names and types, fetched from the provider when the send goes out, never through the UI.
// A forward waits out its undo window and goes out exactly once, like a reply. Each scenario
// is one way a forward could lose the original, its files or its MIME, thread into the
// original's conversation, go out twice, or never go out.

import type { AccountId, Draft, Message, MessageId } from '@letterbox/protocol'
import type { Seed, SeedAttachment, SeedMessage, SimMailbox } from '@letterbox/sim-provider/contract'
import { filesOf, readSent } from '@letterbox/sim-provider/sent'
import { placeholderContent } from '@letterbox/sim-provider/store'
import type { CoreClient } from '../src/client.ts'
import {
  ME,
  openThread,
  PASSWORD,
  readThread,
  signIn,
  standardSeed,
  sync,
  thread,
  untilAccounts,
  watchThread,
} from '../src/fixtures.ts'
import { type CoreOptions, HELD_WINDOW, type Scenario, scenario } from '../src/scenario.ts'
import { draft, idsOf } from '../src/sending.ts'

/** The files the contract carries: a name that is not ASCII, a plain one, and one too long for a line. */
const FILES: readonly SeedAttachment[] = [
  { name: 'Grüße aus München – Vertrag.pdf', mime: 'application/pdf', size: 5000 },
  { name: 'notes.txt', mime: 'text/plain', size: 300 },
  { name: `${'a-file-name-that-runs-well-past-one-line-of-a-header-'.repeat(2)}end.csv`, mime: 'text/csv', size: 90 },
]

const CONTRACT: SeedMessage = {
  key: 'contract',
  mailboxes: ['inbox'],
  from: { name: 'Ana', address: 'ana@example.com' },
  to: [ME],
  cc: ['ben@example.com'],
  subject: 'The contract',
  text: 'Here is the contract.\nSign by Friday.',
  html: '<p>Here is the contract.</p><p>Sign by Friday.</p>',
  sentAt: '2025-12-10T09:00:00.000Z',
  attachments: FILES,
}

/** The text the core writes for a forward of the contract, under what the user wrote. */
const FORWARDED = [
  '---------- Forwarded message ---------',
  'From: Ana <ana@example.com>',
  'Date: Wed, 10 Dec 2025 09:00:00 +0000',
  'Subject: The contract',
  `To: <${ME}>`,
  'Cc: <ben@example.com>',
  '',
  'Here is the contract.\nSign by Friday.',
].join('\n')

const seed = (t: Scenario): Seed => {
  const standard = standardSeed(t.dialect)
  return { ...standard, messages: [...standard.messages, CONTRACT] }
}

/** A forward of `original` to Dan, with a line of the user's own. */
const forward = (accountId: AccountId, original: MessageId, more: Partial<Draft> = {}): Draft =>
  draft(accountId, null, {
    to: ['dan@example.com'],
    subject: 'Fwd: The contract',
    text: 'Dan, see below.',
    forwardOf: original,
    ...more,
  })

/** The standard mailbox with the contract in it, a core with `options`, signed in and synced. */
async function begin(t: Scenario, options: CoreOptions = {}) {
  const box = t.mailbox(seed(t))
  const core = t.startCore(options)
  await core.hello()
  const accountId = await signIn(t, core, ME, PASSWORD)
  await sync(core)
  return { core, box, accountId }
}

/** Starts with the contract delivered, and opens it so its body is there to forward. */
async function startWithContract(t: Scenario, options: CoreOptions = {}) {
  const started = await begin(t, options)
  const row = await thread(started.core, 'The contract')
  const original = (await readThread(started.core, row.id))?.messages[0]
  if (original?.body.state !== 'ready') throw new Error('the contract did not load')
  return { ...started, original, originalThread: row }
}

/** What the provider got for the one forward it holds, and checks that every line of it is plain short ASCII. */
function delivered(t: Scenario, box: SimMailbox) {
  const copies = box.sent()
  t.equal(copies.length, 1, 'the provider got the forward once')
  const raw = copies[0]?.raw ?? ''
  const lines = raw.split('\r\n')
  t.equal(
    lines.filter((line) => line.length > 78 || !/^[\x20-\x7e]*$/.test(line)),
    [],
    'every line of the message is printable ASCII within 78 characters, the long and accented file names too',
  )
  return { raw, copy: copies[0] }
}

/** The names, types and contents of the files the core carried, as a check compares them. */
const expectedFiles = (files: readonly SeedAttachment[]) =>
  files.map((file) => ({ name: file.name, mime: file.mime, inline: false, content: placeholderContent(file) }))

const namesOf = (message: Message | undefined) =>
  message?.attachments.map((attachment) => [attachment.name, attachment.mime, attachment.size])

scenario(
  'a forward carries the original and its files, and the provider gets it once with the right MIME',
  async (t) => {
    const { core, box, accountId, original, originalThread } = await startWithContract(t)
    const send = await core.command({ kind: 'send', draft: forward(accountId, original.id) })
    t.equal(send.kind, 'accepted', 'the forward is accepted')
    t.equal((await core.settled(send.change)).result, 'done', 'it settles as done')

    const { raw, copy } = delivered(t, box)
    t.equal(copy?.recipients, ['dan@example.com'], 'it went to Dan alone')
    t.check(
      !/^(In-Reply-To|References):/im.test(raw) && raw.includes('X-Forwarded-Message-Id: <contract@sim.test>'),
      'it answers nothing, and names the original in X-Forwarded-Message-Id only',
    )
    t.check(/^Content-Type: multipart\/mixed;/m.test(raw), 'the text and the files travel as multipart/mixed')
    t.equal(filesOf(raw), expectedFiles(FILES), 'each file arrives whole, under its own name and type')
    const read = readSent(raw, null).body
    t.equal(read.text, `Dan, see below.\n\n${FORWARDED}`, 'the text quotes the original under the forwarded block')
    t.check(
      (read.html ?? '').includes('---------- Forwarded message ---------<br>') &&
        (read.html ?? '').includes('<p>Here is the contract.</p><p>Sign by Friday.</p>'),
      'the html part holds the forwarded block and the original html',
    )
    t.equal(box.calls().attachment, FILES.length, 'each file was fetched from the provider once')

    const row = await thread(core, 'Fwd: The contract')
    t.equal(
      [row.messageCount, row.hasAttachments, row.turn],
      [1, true, { holder: 'theirs', reason: 'i-wrote-last' }],
      'the forward is a conversation of its own, with files, waiting on Dan',
    )
    t.equal(
      await thread(core, 'The contract'),
      originalThread,
      "the original's conversation is exactly as it was: no message added, the turn unmoved",
    )
    const sent = (await readThread(core, row.id))?.messages[0]
    t.equal(namesOf(sent), namesOf(original), 'the forward lists the files the original does')

    box.expireCursors()
    await sync(core)
    const again = await readThread(core, row.id)
    t.equal(idsOf(again), [sent?.id], 'a full resync finds the same one message')
    t.equal(namesOf(again?.messages[0]), namesOf(original), "and the provider's copy lists the same files")
  },
)

scenario('a forward of a forward carries the same files from the copy the provider kept', async (t) => {
  const { core, box, accountId, original } = await startWithContract(t)
  const first = await core.command({ kind: 'send', draft: forward(accountId, original.id) })
  t.equal((await core.settled(first.change)).result, 'done', 'the first forward goes out')
  await sync(core)
  const row = await thread(core, 'Fwd: The contract')
  const mine = (await readThread(core, row.id))?.messages[0]
  if (!mine) throw new Error('the forward has no message')
  const again = forward(accountId, mine.id, { to: ['erin@example.com'], subject: 'Fwd: Fwd: The contract', text: '' })
  const second = await core.command({ kind: 'send', draft: again })
  t.equal((await core.settled(second.change)).result, 'done', 'the second forward goes out')
  const raw = box.sent()[1]?.raw ?? ''
  t.equal(filesOf(raw), expectedFiles(FILES), 'the files arrive whole a second time')
  t.check(
    readSent(raw, null).body.text.startsWith('---------- Forwarded message ---------\nFrom: <me@sim.test>'),
    'with nothing of my own to say, the text opens with the block, from me',
  )
})

scenario('a forward undone in its window never goes out, and no file is fetched', async (t) => {
  const { core, box, accountId, original } = await startWithContract(t, { undoWindow: HELD_WINDOW })
  const send = await core.command({ kind: 'send', draft: forward(accountId, original.id) })
  const row = await thread(core, 'Fwd: The contract')
  const held = (await readThread(core, row.id))?.messages[0]
  t.equal(
    [held?.delivery?.state, namesOf(held)],
    ['held', namesOf(original)],
    'the forward waits in its undo window, listing the files it will carry',
  )
  const undo = await core.command({ kind: 'undo', change: send.change })
  t.equal(
    [(await core.settled(send.change)).result, (await core.settled(undo.change)).result],
    ['undone', 'done'],
    'the forward settles as undone and the undo as done',
  )
  t.equal(await readThread(core, row.id), null, 'its conversation is gone')
  await sync(core)
  t.equal(
    [box.calls().send, box.calls().attachment, box.sent()],
    [0, 0, []],
    'the provider was never asked to send it, nor for any file',
  )
})

scenario('a forward whose answer is lost is looked up, not sent again, and its files are fetched once', async (t) => {
  const { core, box, accountId, original } = await startWithContract(t)
  box.damageNextSendAnswer('disconnect')
  const send = await core.command({ kind: 'send', draft: forward(accountId, original.id) })
  t.equal((await core.settled(send.change)).result, 'done', 'the core finds the copy and settles it done')
  const { raw } = delivered(t, box)
  t.equal(filesOf(raw), expectedFiles(FILES), 'the one copy has every file')
  t.equal([box.calls().send, box.calls().attachment], [1, FILES.length], 'one send, and each file fetched once')
})

/** Sends a forward while the provider is offline, and waits until its first try has failed. */
async function forwardOffline(core: CoreClient, box: SimMailbox, accountId: AccountId, original: MessageId) {
  box.setOffline(true)
  const accounts = core.subscribe({ view: 'accounts' })
  const send = await core.command({ kind: 'send', draft: forward(accountId, original) })
  await untilAccounts(accounts, (list) => list[0]?.status.state === 'offline')
  return send.change
}

scenario('a forward made offline goes out once, with its files, when the provider is back', async (t) => {
  const { core, box, accountId, original } = await startWithContract(t)
  const change = await forwardOffline(core, box, accountId, original.id)
  const row = await thread(core, 'Fwd: The contract')
  t.equal((await readThread(core, row.id))?.messages[0]?.delivery?.state, 'sending', 'it waits for the provider')
  box.setOffline(false)
  await sync(core)
  t.equal((await core.settled(change)).result, 'done', 'it settles once the provider is reachable')
  const { raw } = delivered(t, box)
  t.equal(filesOf(raw), expectedFiles(FILES), 'with every file')
  t.equal(box.calls().send, 1, 'in one send')
})

scenario('a forward whose original is gone before it goes out fails, and nothing is sent', async (t) => {
  const { core, box, accountId, original } = await startWithContract(t)
  const change = await forwardOffline(core, box, accountId, original.id)
  box.expunge('contract')
  box.setOffline(false)
  await sync(core)
  t.equal((await core.settled(change)).result, { failed: 'unknown-target' }, 'it fails: its files are gone')
  const row = await thread(core, 'Fwd: The contract')
  t.equal(
    (await readThread(core, row.id))?.messages[0]?.delivery?.state,
    'failed',
    'it stays in its conversation, marked failed',
  )
  t.equal([box.calls().send, box.sent()], [0, []], 'the provider was never asked to send it')
})

scenario('a forward is refused until the original has loaded, and when it also answers a message', async (t) => {
  const { core, box, accountId } = await begin(t)
  const row = await thread(core, 'The contract')
  // The provider holds the body, so the conversation opens with it still loading.
  box.holdBodies()
  const watch = watchThread(core, row.id)
  const unopened = (await watch.next())?.messages[0]
  if (unopened?.body.state !== 'loading') throw new Error('the contract was not loading')
  const early = await core.command({ kind: 'send', draft: forward(accountId, unopened.id) })
  t.equal(
    [early.kind, early.kind === 'rejected' && early.reason],
    ['rejected', 'conflict'],
    'a forward of a message whose body has not loaded is refused as a conflict',
  )
  const both = await core.command({ kind: 'send', draft: forward(accountId, unopened.id, { inReplyTo: unopened.id }) })
  t.equal(
    [both.kind, both.kind === 'rejected' && both.reason],
    ['rejected', 'invalid'],
    'a draft that both answers and forwards is invalid',
  )
  t.equal(box.sent(), [], 'nothing went out')
  box.releaseBodies()
  watch.close()
})

scenario('a forward without some of the original files carries only the rest, and fetches only those', async (t) => {
  const { core, box, accountId, original } = await startWithContract(t, { undoWindow: HELD_WINDOW })
  // The first file comes off, so a file fetched by its place among those carried would be the wrong one.
  const without = original.attachments.slice(0, 1).map((file) => file.blobId)
  const send = await core.command({ kind: 'send', draft: forward(accountId, original.id, { forwardWithout: without }) })
  t.equal(send.kind, 'accepted', 'the forward is accepted')
  const row = await thread(core, 'Fwd: The contract')
  const held = (await readThread(core, row.id))?.messages[0]
  t.equal(
    namesOf(held),
    namesOf(original)?.slice(1),
    'while it waits in its undo window, it lists only the files it will carry',
  )
  await core.stop()
  // A restart reads the outbox back, and the files left out must stay out. It starts past the window.
  const again = t.startCore({ now: '2026-01-01T02:00:00.000Z' })
  await again.hello()
  await sync(again)
  t.equal((await again.settled(send.change)).result, 'done', 'after a restart the window ends and it goes out')
  const { raw } = delivered(t, box)
  t.equal(filesOf(raw), expectedFiles(FILES.slice(1)), 'it carries the other files whole, and not the one left out')
  t.equal(box.calls().attachment, FILES.length - 1, 'only the files it carries were fetched')
  t.check(
    readSent(raw, null).body.text.startsWith(`Dan, see below.\n\n${FORWARDED}`),
    'the text still quotes the whole original',
  )
})

scenario(
  'leaving out a file is refused on a draft that forwards nothing, or for a file the original lacks',
  async (t) => {
    const { core, box, accountId, original } = await startWithContract(t)
    const file = original.attachments[0]?.blobId
    if (!file) throw new Error('the contract has no files')
    const refused = async (message: Draft) => {
      const answer = await core.command({ kind: 'send', draft: message })
      return answer.kind === 'rejected' ? answer.reason : answer.kind
    }
    const reply = draft(accountId, original.id, { to: ['ana@example.com'], forwardWithout: [file] })
    t.equal(await refused(reply), 'invalid', 'a reply that leaves out a file is invalid')
    const lone = draft(accountId, null, { to: ['dan@example.com'], forwardWithout: [file] })
    t.equal(await refused(lone), 'invalid', 'a new message that leaves out a file is invalid')
    const elsewhere = forward(accountId, original.id, { forwardWithout: [`${file}0` as typeof file] })
    t.equal(await refused(elsewhere), 'invalid', 'a forward that leaves out a file the original lacks is invalid')
    await sync(core)
    t.equal(box.sent(), [], 'nothing went out')
  },
)

scenario("a core killed while it fetches a forward's files sends the forward once after the restart", async (t) => {
  const first = await startWithContract(t)
  first.box.holdAttachments()
  const send = await first.core.command({ kind: 'send', draft: forward(first.accountId, first.original.id) })
  await first.box.attachmentHeld()
  await first.core.kill()
  first.box.releaseAttachments()
  t.equal(first.box.sent(), [], 'the core stopped before it sent anything')

  // A start runs no pass of its own, so the restart must carry the forward it found due.
  const core = t.startCore()
  await core.hello()
  t.equal((await core.settled(send.change)).result, 'done', 'the restarted core sends it, with no sync')
  const { raw } = delivered(t, first.box)
  t.equal(filesOf(raw), expectedFiles(FILES), 'with every file')
  t.equal(first.box.calls().send, 1, 'in one send')
})

scenario(
  'a forward of my forward the provider may not hold yet waits for it, then goes out with its files',
  async (t) => {
    // Checks come an hour apart in a four-hour window, which core-sim holds back, so only the
    // first lookup of the first forward happens.
    const { core, box, accountId, original } = await startWithContract(t, { confirmWindow: 4 * HELD_WINDOW })
    box.holdSends()
    const earlier = await core.command({ kind: 'send', draft: forward(accountId, original.id) })
    await box.sendHeld()
    const row = await thread(core, 'Fwd: The contract')
    const mine = (await readThread(core, row.id))?.messages[0]
    if (!mine) throw new Error('the first forward has no message')
    const again = forward(accountId, mine.id, { to: ['erin@example.com'], subject: 'Fwd: Fwd: The contract' })
    const later = await core.command({ kind: 'send', draft: again })
    t.equal(later.kind, 'accepted', 'a forward of the first forward is accepted: its text is here')
    // Wait until its undo window has ended, so its pass comes before the first one's lookup.
    const open = await openThread(core, (await thread(core, 'Fwd: Fwd: The contract')).id)
    while (open.latest()?.messages[0]?.delivery?.state !== 'sending') await open.next()
    open.close()

    // The provider takes the first forward, its answer is lost, and the provider is gone before
    // the core can look it up. So the core cannot tell where the first forward is.
    const accounts = core.subscribe({ view: 'accounts' })
    box.damageNextSendAnswer('disconnect')
    box.releaseSends()
    box.setOffline(true)
    await untilAccounts(accounts, (list) => list[0]?.status.state === 'offline')
    const waiting = await thread(core, 'Fwd: Fwd: The contract')
    t.equal(
      [(await readThread(core, waiting.id))?.messages[0]?.delivery?.state, box.sent().length],
      ['sending', 1],
      'the second forward waits, unsent and not failed, while the first has no copy the core knows of',
    )

    box.setOffline(false)
    await sync(core)
    t.equal(
      [(await core.settled(earlier.change)).result, (await core.settled(later.change)).result],
      ['done', 'done'],
      'once a sync finds the first forward, both settle done',
    )
    t.equal(box.sent().length, 2, 'the provider got each forward once')
    t.equal(filesOf(box.sent()[1]?.raw ?? ''), expectedFiles(FILES), "the second carries the first one's files whole")
  },
)

scenario('a forward leaves out a Message-ID too long for its line, and goes out', async (t) => {
  const { core, box, accountId } = await begin(t)
  // 972 characters fit after "X-Forwarded-Message-Id: <" and before ">" within 998. 973 do not.
  const fits = `${'a'.repeat(963)}@sim.test`
  const over = `${'b'.repeat(964)}@sim.test`
  for (const [key, messageId] of [
    ['fits', fits],
    ['over', over],
  ] as const) {
    box.deliver({ ...CONTRACT, key, subject: `Id that ${key}`, attachments: 0, messageId })
  }
  await sync(core)
  for (const [index, subject] of ['Id that fits', 'Id that over'].entries()) {
    const row = await thread(core, subject)
    const original = (await readThread(core, row.id))?.messages[0]
    if (!original) throw new Error(`${subject} did not arrive`)
    const send = await core.command({
      kind: 'send',
      draft: forward(accountId, original.id, { subject: `Fwd: ${subject}` }),
    })
    t.equal((await core.settled(send.change)).result, 'done', `the forward of "${subject}" goes out`)
    const lines = (box.sent()[index]?.raw ?? '').split('\r\n')
    t.check(
      lines.every((line) => line.length <= 998),
      `no line of the forward of "${subject}" is longer than 998 characters`,
    )
  }
  const named = box
    .sent()
    .map((copy) => copy.raw.split('\r\n').filter((line) => line.startsWith('X-Forwarded-Message-Id:')))
  t.equal(named, [[`X-Forwarded-Message-Id: <${fits}>`], []], 'the id that fits is named, the longer one left out')
})

scenario('a forward of my forward whose answer was lost goes out as soon as a lookup finds the first', async (t) => {
  // Its checks come an hour apart, which core-sim holds back, so only the first lookup happens.
  const { core, box, accountId, original } = await startWithContract(t, { confirmWindow: 4 * HELD_WINDOW })
  box.holdSends()
  const earlier = await core.command({ kind: 'send', draft: forward(accountId, original.id) })
  await box.sendHeld()
  const row = await thread(core, 'Fwd: The contract')
  const mine = (await readThread(core, row.id))?.messages[0]
  if (!mine) throw new Error('the first forward has no message')
  const again = forward(accountId, mine.id, { to: ['erin@example.com'], subject: 'Fwd: Fwd: The contract' })
  const later = await core.command({ kind: 'send', draft: again })
  // Wait until its undo window has ended, so it is due while the first is still on its way.
  const open = await openThread(core, (await thread(core, 'Fwd: Fwd: The contract')).id)
  while (open.latest()?.messages[0]?.delivery?.state !== 'sending') await open.next()

  box.damageNextSendAnswer('disconnect')
  box.releaseSends()
  t.equal((await core.settled(earlier.change)).result, 'done', 'the lookup finds the first forward')
  t.equal(
    (await core.settled(later.change)).result,
    'done',
    'and the second, which waited for it, goes out at once, with no sync',
  )
  open.close()
  t.equal(box.sent().length, 2, 'the provider got each forward once')
  t.equal(filesOf(box.sent()[1]?.raw ?? ''), expectedFiles(FILES), "the second carries the first one's files whole")
})
