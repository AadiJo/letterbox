// A turn the user sets, such as Done, holds only until the conversation moves: a message the
// provider holds that was sent after the newest one it had when the user set it. Then the rule
// decides again, so the other person's reply makes it my turn and a reply of mine makes me
// the one waiting. Mail that arrives late but was sent before, as a backfill brings, does not
// end it. Every scenario starts from the standard mailbox, where Ben's review is my turn.

import type { ThreadId, TurnState, UndoConflict } from '@letterbox/protocol'
import { fromBen, ME, start, sync, thread, threads } from '../src/fixtures.ts'
import { HELD_WINDOW, scenario, type Scenario } from '../src/scenario.ts'
import { ASKED, asked, draft, startWith } from '../src/sending.ts'
import { accept } from '../src/undoing.ts'

const MINE: TurnState = { holder: 'mine', reason: 'they-wrote-last' }
const THEIRS: TurnState = { holder: 'theirs', reason: 'i-wrote-last' }
const DONE: TurnState = { holder: 'none', reason: 'set-by-user' }

/** Ben's answer in the review conversation, sent at `sentAt`. `subject` is a reply's unless given. */
const benAgain = (key: string, sentAt: string, subject = `Re: ${ASKED}`) =>
  fromBen(key, subject, sentAt, { replyTo: ['review'], text: 'Any news on the draft?' })

scenario('done holds until they reply, and their reply makes it my turn again', async (t) => {
  const { core, box } = await start(t)
  const review = await thread(core, ASKED)
  t.equal(review.turn, MINE, 'Ben asked, so it is my turn')
  const done = await accept(t, core, { kind: 'set-turn', threadIds: [review.id], turn: 'none' }, 'done')
  t.equal((await core.settled(done)).result, 'done', 'done settles at once')
  t.equal((await thread(core, ASKED)).turn, DONE, "it is nobody's turn, set by the user")

  // New mail elsewhere does not touch it.
  box.deliver(fromBen('standup', 'Standup moved to 10', '2025-12-05T09:00:00.000Z'))
  await sync(core)
  t.equal((await thread(core, ASKED)).turn, DONE, 'mail in another conversation leaves it done')

  box.deliver(benAgain('nudge', '2025-12-06T09:00:00.000Z'))
  await sync(core)
  const after = await thread(core, ASKED)
  t.equal(after.turn, MINE, 'Ben wrote again, so the rule decides: it is my turn')
  t.equal(after.messageCount, 2, 'his reply joined the conversation')

  // Done again, against his reply this time. Its undo hands the turn back to the rule.
  const again = await accept(t, core, { kind: 'set-turn', threadIds: [review.id], turn: 'none' }, 'done again')
  t.equal((await core.settled(again)).result, 'done', 'done settles')
  t.equal((await thread(core, ASKED)).turn, DONE, 'it is done again')
  const undo = await accept(t, core, { kind: 'undo', change: again }, 'its undo')
  t.equal((await core.settled(undo)).result, 'done', 'the undo settles')
  t.equal((await thread(core, ASKED)).turn, MINE, 'the undo takes it back to my turn, not to the done his reply ended')
})

scenario('done holds when a message sent before it arrives late, as a backfill brings', async (t) => {
  const { core, box } = await start(t)
  const review = await thread(core, ASKED)
  const done = await accept(t, core, { kind: 'set-turn', threadIds: [review.id], turn: 'none' }, 'done')
  t.equal((await core.settled(done)).result, 'done', 'done settles')

  // Sent on Dec 1, a day before the question it answers reached me, and delivered only now.
  // Its subject has no "Re:", since it becomes the conversation's first message.
  box.deliver(benAgain('early', '2025-12-01T12:00:00.000Z', ASKED))
  await sync(core)
  const after = await thread(core, ASKED)
  t.equal(after.messageCount, 2, 'the late message joined the conversation')
  t.equal(after.turn, DONE, 'it was sent before the newest message done was set against, so done holds')

  box.deliver(benAgain('nudge', '2025-12-06T09:00:00.000Z'))
  await sync(core)
  t.equal((await thread(core, ASKED)).turn, MINE, 'a message sent after it ends done')
})

scenario('a reply of mine ends done once the provider holds it, and then I am the one waiting', async (t) => {
  const { core, accountId } = await start(t)
  const { threadId, question } = await asked(core)
  const done = await accept(t, core, { kind: 'set-turn', threadIds: [threadId], turn: 'none' }, 'done')
  t.equal((await core.settled(done)).result, 'done', 'done settles')
  const send = await core.command({ kind: 'send', draft: draft(accountId, question.id) })
  t.equal(send.kind, 'accepted', 'the reply is accepted')
  t.equal((await core.settled(send.change)).result, 'done', 'the provider took the reply')
  await sync(core)
  t.equal((await thread(core, ASKED)).turn, THEIRS, 'my reply moved the conversation: it waits on Ben')
})

scenario('a reply of mine still in its undo window leaves done, and undoing it keeps done', async (t) => {
  const { core, accountId } = await startWith(t, { undoWindow: HELD_WINDOW })
  const { threadId, question } = await asked(core)
  const done = await accept(t, core, { kind: 'set-turn', threadIds: [threadId], turn: 'none' }, 'done')
  t.equal((await core.settled(done)).result, 'done', 'done settles')
  const send = await core.command({ kind: 'send', draft: draft(accountId, question.id) })
  t.equal(send.kind, 'accepted', 'the reply waits in its undo window')
  t.equal((await thread(core, ASKED)).turn, DONE, 'the provider does not hold it, so done holds')
  await core.command({ kind: 'undo', change: send.change })
  t.equal((await core.settled(send.change)).result, 'undone', 'the reply is undone')
  t.equal((await thread(core, ASKED)).turn, DONE, 'and done still holds')
})

scenario('a turn let go after 30 days comes back to my turn when they reply', async (t) => {
  const { core, box } = await start(t)
  // Ana's photos are 42 days old on the core's clock, and her question is still mine to answer.
  const photos = await thread(core, 'Trip photos')
  t.equal(photos.turn, MINE, 'the old photos are my turn')
  const letGo = await accept(t, core, { kind: 'set-turn', threadIds: [photos.id], turn: 'none' }, 'letting it go')
  t.equal((await core.settled(letGo)).result, 'done', 'letting go settles')
  t.equal((await thread(core, 'Trip photos')).turn, DONE, 'it is let go')

  box.deliver({
    key: 'photos-again',
    mailboxes: ['inbox'],
    from: { name: 'Ana', address: 'ana@example.com' },
    to: [ME],
    subject: 'Re: Trip photos',
    text: 'Did you get them?',
    sentAt: '2025-12-31T09:00:00.000Z',
    replyTo: ['photos'],
  })
  await sync(core)
  const after = await thread(core, 'Trip photos')
  t.equal(
    [after.turn, after.lastMessageAt],
    [MINE, '2025-12-31T09:00:00.000Z'],
    'Ana wrote again, so it is my turn, and its last message is a day old, so it is not one to let go',
  )
})

scenario('undoing done after they replied is refused, as is undoing a hand-back', async (t) => {
  const { core, box } = await start(t)
  const review = await thread(core, ASKED)
  const done = await accept(t, core, { kind: 'set-turn', threadIds: [review.id], turn: 'none' }, 'done')
  t.equal((await core.settled(done)).result, 'done', 'done settles')
  box.deliver(benAgain('nudge', '2025-12-06T09:00:00.000Z'))
  await sync(core)
  t.equal((await thread(core, ASKED)).turn, MINE, 'Ben replied, so it is my turn')

  const changed: UndoConflict = { kind: 'changed', field: { kind: 'turn', threadId: review.id } }
  const undoDone = await core.command({ kind: 'undo', change: done })
  t.equal(
    undoDone.kind === 'rejected' && [undoDone.reason, undoDone.conflict],
    ['conflict', changed],
    'done no longer holds, so its undo is refused, naming the conversation',
  )
  t.equal((await thread(core, ASKED)).turn, MINE, 'it is still my turn')

  // Waiting on Ben, then handed back to the rule. Undoing the hand-back would put "theirs"
  // back over his newer message, so it is refused too.
  const theirs = await accept(t, core, { kind: 'set-turn', threadIds: [review.id], turn: 'theirs' }, 'theirs')
  t.equal((await core.settled(theirs)).result, 'done', 'setting theirs settles')
  const auto = await accept(t, core, { kind: 'set-turn', threadIds: [review.id], turn: 'auto' }, 'the hand-back')
  t.equal((await core.settled(auto)).result, 'done', 'the hand-back settles')
  box.deliver(benAgain('nudge-2', '2025-12-07T09:00:00.000Z'))
  await sync(core)
  const undoAuto = await core.command({ kind: 'undo', change: auto })
  t.equal(
    undoAuto.kind === 'rejected' && [undoAuto.reason, undoAuto.conflict],
    ['conflict', changed],
    'the conversation moved since the hand-back, so its undo is refused',
  )
  t.equal((await thread(core, ASKED)).turn, MINE, 'and it stays my turn')

  // With no newer message in between, an undo still takes done back.
  const again = await accept(t, core, { kind: 'set-turn', threadIds: [review.id], turn: 'none' }, 'done again')
  t.equal((await core.settled(again)).result, 'done', 'done settles')
  const undo = await accept(t, core, { kind: 'undo', change: again }, 'its undo')
  t.equal((await core.settled(undo)).result, 'done', 'the undo settles')
  t.equal((await thread(core, ASKED)).turn, MINE, 'the rule decides again: my turn')
})

scenario('a merge keeps done until a message sent after it, then their reply makes it my turn', async (t) => {
  const { core, box } = await start(t)
  box.deliver(fromBen('lunch-again', 'Lunch on Friday?', '2025-12-05T09:00:00.000Z'))
  await sync(core)
  const lunches = async () => (await threads(core)).filter((row) => row.subject === 'Lunch on Friday?')
  const later = (await lunches()).find((row) => row.messageCount === 1)
  if (!later) throw new Error('the second lunch message is not a conversation of its own')
  const done = await accept(t, core, { kind: 'set-turn', threadIds: [later.id], turn: 'none' }, 'done')
  t.equal((await core.settled(done)).result, 'done', 'done settles')

  // A message that answers both joins them, but it was sent before Ben's second lunch message.
  // The older conversation survives and takes done, which still holds.
  box.deliver(
    fromBen('lunch-both', 'Re: Lunch on Friday?', '2025-12-04T09:00:00.000Z', {
      replyTo: ['lunch-ask', 'lunch-again'],
    }),
  )
  await sync(core)
  const merged = await lunches()
  t.equal(
    merged.map((row) => [row.messageCount, row.turn]),
    [[4, DONE]],
    'they are one conversation of four messages, still done',
  )

  box.deliver(fromBen('lunch-reply', 'Re: Lunch on Friday?', '2025-12-07T09:00:00.000Z', { replyTo: ['lunch-again'] }))
  await sync(core)
  t.equal(
    (await lunches()).map((row) => row.turn),
    [MINE],
    'Ben wrote after the message done was set against, so it is my turn',
  )
})

/**
 * Two lunch conversations about to merge: Ana's, where I answered on Dec 1, and Ben's own
 * message of Dec 5, each marked done. Ana's holds the oldest message, so it survives the
 * merge. `anaAgain` has Ana write again on Dec 3, after hers is marked, which ends that done.
 */
async function twoLunches(t: Scenario, anaAgain: boolean) {
  const { core, box } = await start(t)
  const lunches = async () => (await threads(core)).filter((row) => row.subject === 'Lunch on Friday?')
  const markDone = async (threadId: ThreadId, what: string) => {
    const done = await accept(t, core, { kind: 'set-turn', threadIds: [threadId], turn: 'none' }, what)
    t.equal((await core.settled(done)).result, 'done', `${what} settles`)
  }
  const [ana] = await lunches()
  if (!ana) throw new Error("Ana's lunch conversation is missing")
  await markDone(ana.id, "done on Ana's lunch")
  if (anaAgain) {
    box.deliver({
      key: 'lunch-ana',
      mailboxes: ['inbox'],
      from: { name: 'Ana', address: 'ana@example.com' },
      to: [ME],
      subject: 'Re: Lunch on Friday?',
      text: 'Noon at the usual place?',
      sentAt: '2025-12-03T09:00:00.000Z',
      replyTo: ['lunch-answer'],
    })
    await sync(core)
    t.equal((await thread(core, 'Lunch on Friday?')).turn, MINE, 'Ana wrote again, so done on hers no longer holds')
  }
  box.deliver(fromBen('lunch-again', 'Lunch on Friday?', '2025-12-05T09:00:00.000Z'))
  await sync(core)
  const ben = (await lunches()).find((row) => row.id !== ana.id)
  if (!ben) throw new Error("Ben's lunch message is not a conversation of its own")
  await markDone(ben.id, "done on Ben's lunch")

  // A message that answers both joins them. It was sent before Ben's lunch message, so the
  // merged conversation's newest message is his: later than done on Ana's, the one done on
  // his was set against.
  box.deliver(
    fromBen('lunch-both', 'Re: Lunch on Friday?', '2025-12-04T09:00:00.000Z', {
      replyTo: ['lunch-ask', 'lunch-again'],
    }),
  )
  await sync(core)
  return { core, box, lunches }
}

scenario('a merge of two conversations both marked done stays done until a reply', async (t) => {
  const { core, box, lunches } = await twoLunches(t, false)
  t.equal(
    (await lunches()).map((row) => [row.messageCount, row.turn]),
    [[4, DONE]],
    "one conversation, still done: done on Ben's still holds against the merged mail",
  )
  box.deliver(fromBen('lunch-reply', 'Re: Lunch on Friday?', '2025-12-07T09:00:00.000Z', { replyTo: ['lunch-again'] }))
  await sync(core)
  t.equal(
    (await lunches()).map((row) => row.turn),
    [MINE],
    'Ben wrote after it, so it is my turn',
  )
})

scenario('a merge takes done from the newer conversation over a done a reply already ended', async (t) => {
  const { lunches } = await twoLunches(t, true)
  t.equal(
    (await lunches()).map((row) => [row.messageCount, row.turn]),
    [[5, DONE]],
    "one conversation, done: Ana's ended done stays ended, and done on Ben's carries on",
  )
})
