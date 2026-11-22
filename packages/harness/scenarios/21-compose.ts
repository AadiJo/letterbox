// A new conversation: a message that answers nothing starts a conversation of its own, waits
// out its undo window like a reply, and an undo inside it leaves nothing behind. The `change`
// view names the conversation that holds a send, so a UI can find a new one, or one a merge moved.

import { fromBen, mailbox, readThread, sync, thread, threads } from '../src/fixtures.ts'
import { HELD_WINDOW, scenario } from '../src/scenario.ts'
import { draft, startWith } from '../src/sending.ts'

const SUBJECT = 'Plans for the spring trip'

scenario('a new conversation waits in its undo window, and an undo leaves no trace of it', async (t) => {
  const { core, box, accountId } = await startWith(t, { undoWindow: HELD_WINDOW })
  const before = await threads(core)
  const message = draft(accountId, null, { to: ['ana@example.com'], subject: SUBJECT, text: 'Shall we plan it?' })
  const send = await core.command({ kind: 'send', draft: message })
  t.equal(send.kind, 'accepted', 'the new message is accepted')

  const row = await thread(core, SUBJECT)
  t.equal(
    [row.messageCount, row.pending, row.mailboxIds, row.turn.holder],
    [1, true, [(await mailbox(core, 'Sent')).id], 'none'],
    'it shows at once as a conversation of its own in Sent, pending, and holds no turn yet',
  )
  const held = await readThread(core, row.id)
  t.equal(
    [held?.messages[0]?.delivery?.state, held?.messages[0]?.to.map((person) => person.address)],
    ['held', ['ana@example.com']],
    'its message waits in its undo window, to Ana',
  )

  const undo = await core.command({ kind: 'undo', change: send.change })
  t.equal(
    [(await core.settled(send.change)).result, (await core.settled(undo.change)).result],
    ['undone', 'done'],
    'the send settles as undone and the undo as done',
  )
  t.equal(await readThread(core, row.id), null, 'its conversation no longer exists')
  t.equal(await threads(core), before, 'every other conversation is exactly as it was')
  await sync(core)
  t.equal([box.calls().send, box.sent()], [0, []], 'the provider was never asked to send it')

  // A restart reads the store again, so a conversation left behind there would come back.
  await core.stop()
  const again = t.startCore({ undoWindow: HELD_WINDOW })
  await again.hello()
  t.equal(await threads(again), before, 'after a restart the conversation is still gone')
})

scenario('a new conversation that goes out holds the turn for the person it went to', async (t) => {
  const { core, box, accountId } = await startWith(t, {})
  const message = draft(accountId, null, { to: ['ana@example.com'], subject: SUBJECT, text: 'Shall we plan it?' })
  const send = await core.command({ kind: 'send', draft: message })
  t.equal((await core.settled(send.change)).result, 'done', 'the window ends and it goes out')
  const row = await thread(core, SUBJECT)
  t.equal(
    [row.messageCount, row.pending, row.turn],
    [1, false, { holder: 'theirs', reason: 'i-wrote-last' }],
    'one message, settled, and now the turn is theirs',
  )
  const raw = box.sent()[0]?.raw ?? ''
  t.check(!/^(In-Reply-To|References):/im.test(raw), 'it answers nothing, so it has no In-Reply-To or References')
  t.equal(box.sent().length, 1, 'the provider got it once')
})

scenario(
  'the change view names the conversation holding a send, follows a merge, and is null once undone',
  async (t) => {
    const { core, box, accountId } = await startWith(t, { undoWindow: HELD_WINDOW })
    const fresh = await core.command({
      kind: 'send',
      draft: draft(accountId, null, { to: ['ana@example.com'], subject: SUBJECT, text: 'Shall we plan it?' }),
    })
    const started = core.subscribe({ view: 'change', change: fresh.change })
    await started.next()
    t.equal(
      started.latest(),
      { threadId: (await thread(core, SUBJECT)).id },
      'it names the conversation a new message started',
    )
    const undo = await core.command({ kind: 'undo', change: fresh.change })
    t.equal((await core.settled(undo.change)).result, 'done', 'the new message is undone')
    t.equal(started.latest(), { threadId: null }, 'once its message is gone, it names no conversation')
    started.close()

    // Two conversations with one subject that nothing links yet. A reply waits in the newer one.
    box.deliver(fromBen('trip-1', 'Bike trip in May', '2025-12-05T09:00:00.000Z'))
    box.deliver(fromBen('trip-2', 'Re: Bike trip in May', '2025-12-06T09:00:00.000Z'))
    await sync(core)
    const trips = async () => (await threads(core)).filter((row) => row.subject.endsWith('Bike trip in May'))
    const newer = (await trips()).find((row) => row.subject.startsWith('Re:'))
    const answered = newer && (await readThread(core, newer.id))?.messages[0]
    if (!newer || !answered) throw new Error('the newer trip conversation is not there')
    const reply = await core.command({
      kind: 'send',
      draft: draft(accountId, answered.id, { subject: 'Re: Bike trip in May', text: 'Count me in.' }),
    })
    const moving = core.subscribe({ view: 'change', change: reply.change })
    await moving.next()
    t.equal(moving.latest(), { threadId: newer.id }, 'a held reply is in the conversation it answers')

    // A message that answers both joins them, and the reply moves into the one that survives.
    box.deliver(
      fromBen('trip-3', 'Re: Bike trip in May', '2025-12-07T09:00:00.000Z', { replyTo: ['trip-1', 'trip-2'] }),
    )
    await sync(core)
    const joined = await trips()
    t.equal(joined.length, 1, 'the two conversations are one now')
    t.equal(
      moving.latest(),
      { threadId: joined[0]?.id ?? null },
      'the view follows the merge to the conversation that holds the reply now',
    )
    t.check(joined[0]?.id !== newer.id, 'which is not the one the reply was written in')
    const taken = await core.command({ kind: 'undo', change: reply.change })
    t.equal(
      [(await core.settled(reply.change)).result, (await core.settled(taken.change)).result, moving.latest()],
      ['undone', 'done', { threadId: null }],
      'undone there, the reply is gone, and the view names no conversation',
    )
    moving.close()
  },
)
