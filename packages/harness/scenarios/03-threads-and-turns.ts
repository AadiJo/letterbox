// Ways the core can group messages wrongly or get a turn wrong.
// Each scenario is one of them.

import { ME, fromBen, mailbox, readThread, start, sync, thread, threads } from '../src/fixtures.ts'
import { scenario } from '../src/scenario.ts'

scenario('a reply in another mailbox joins the conversation it answers', async (t) => {
  const { core, box } = await start(t)
  const lunch = await thread(core, 'Lunch on Friday?')
  const inbox = await mailbox(core, 'Inbox')
  const sent = await mailbox(core, 'Sent')
  t.equal(lunch.messageCount, 2, 'the question and the answer are one conversation')
  t.equal(lunch.mailboxIds.toSorted(), [inbox.id, sent.id].toSorted(), 'it spans Inbox and Sent')
  const open = await readThread(core, lunch.id)
  t.equal(
    open?.messages.map((message) => message.from.isMe),
    [false, true],
    'messages are in the order they were sent',
  )
  // A first sync lists the answer before the question it answers. A reply that comes later
  // joins through its own reply chain instead.
  box.deliver(
    fromBen('lunch-late', 'Re: Lunch on Friday?', '2025-12-05T09:00:00.000Z', {
      replyTo: ['lunch-ask', 'lunch-answer'],
    }),
  )
  await sync(core)
  const after = await thread(core, 'Lunch on Friday?')
  t.equal([after.id, after.messageCount], [lunch.id, 3], 'a reply that arrives later joins the same conversation')
})

scenario('messages only join a conversation when both the reply chain and the subject match', async (t) => {
  const { core, box } = await start(t)
  box.deliver(fromBen('same-subject', 'Lunch on Friday?', '2025-12-05T09:00:00.000Z'))
  box.deliver(fromBen('hijack', 'Unrelated: parking permits', '2025-12-05T10:00:00.000Z', { replyTo: ['lunch-ask'] }))
  await sync(core)
  const all = await threads(core)
  t.equal(
    all
      .filter((item) => item.subject === 'Lunch on Friday?')
      .map((item) => item.messageCount)
      .toSorted(),
    [1, 2],
    'the same subject with no reply chain is its own conversation',
  )
  t.equal(
    all.find((item) => item.subject === 'Unrelated: parking permits')?.messageCount,
    1,
    'a reply with a new subject is its own conversation',
  )
})

scenario('each conversation says whose turn it is and why', async (t) => {
  const { core } = await start(t)
  const turns = Object.fromEntries((await threads(core)).map((item) => [item.subject, item.turn]))
  t.equal(
    turns,
    {
      'Lunch on Friday?': { holder: 'theirs', reason: 'i-wrote-last' },
      'Can you review the draft?': { holder: 'mine', reason: 'they-wrote-last' },
      'December offers': { holder: 'none', reason: 'automated' },
      'Budget numbers': { holder: 'none', reason: 'not-addressed-to-me' },
      'Trip photos': { holder: 'mine', reason: 'they-wrote-last' },
    },
    'the standard mailbox has one turn of each kind',
  )
  t.equal(
    (await threads(core, { turn: 'theirs' })).map((item) => item.subject),
    ['Lunch on Friday?'],
    'the list filters by turn',
  )
})

scenario('an answer from the other person hands the turn back', async (t) => {
  const { core, box } = await start(t)
  box.deliver({
    key: 'lunch-confirm',
    mailboxes: ['inbox'],
    from: { name: 'Ana', address: 'ana@example.com' },
    to: [ME],
    subject: 'Re: Lunch on Friday?',
    text: 'Great. Where?',
    sentAt: '2025-12-05T09:00:00.000Z',
    replyTo: ['lunch-ask', 'lunch-answer'],
  })
  await sync(core)
  const lunch = await thread(core, 'Lunch on Friday?')
  t.equal(
    [lunch.messageCount, lunch.turn.holder, lunch.turn.reason],
    [3, 'mine', 'they-wrote-last'],
    'it is my turn again',
  )
})

scenario('a correction to a turn sticks until it is handed back to the rule', async (t) => {
  const first = await start(t)
  const target = await thread(first.core, 'Can you review the draft?')
  const correction = await first.core.command({ kind: 'set-turn', threadIds: [target.id], turn: 'none' })
  t.equal((await first.core.settled(correction.change)).result, 'done', 'the correction settles as done')
  t.equal(
    (await thread(first.core, 'Can you review the draft?')).turn,
    { holder: 'none', reason: 'set-by-user' },
    'the correction shows with its reason',
  )
  await first.core.stop()

  const core = t.startCore()
  await core.hello()
  t.equal((await thread(core, 'Can you review the draft?')).turn.reason, 'set-by-user', 'it survives a restart')
  const handBack = await core.command({ kind: 'set-turn', threadIds: [target.id], turn: 'auto' })
  await core.settled(handBack.change)
  t.equal(
    (await thread(core, 'Can you review the draft?')).turn,
    { holder: 'mine', reason: 'they-wrote-last' },
    'the rule decides again',
  )
})
