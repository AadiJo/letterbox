// Ways a notification can bother the user for nothing, or stay quiet when it matters: mail
// from the first sync, a resync or the catch-up after a restart told as new, mail from a
// machine or from the user told, mail outside the inbox told, one conversation told twice,
// or a reply never told.
//
// The core sends `your-turn` before the answer to the sync that brought the mail, and the
// client keeps every message no wait took. So when the first `your-turn` a scenario takes is
// the one for a sentinel delivered last, nothing before it was told.

import type { SeedMessage } from '@letterbox/sim-provider/contract'
import type { Scenario } from '../src/scenario.ts'
import type { SignedIn } from '../src/fixtures.ts'
import { fromBen, ME, standardSeed, start, sync, thread } from '../src/fixtures.ts'
import { scenario } from '../src/scenario.ts'

const ANA = { name: 'Ana', address: 'ana@example.com' }

/** Delivers a message from Ben, syncs, and checks it is the next conversation told. */
async function sentinel(t: Scenario, { core, box }: Pick<SignedIn, 'core' | 'box'>, what: string, key = 'sentinel') {
  const subject = `Are you around? (${key})`
  box.deliver(fromBen(key, subject, '2025-12-09T09:00:00.000Z'))
  await sync(core)
  const told = await core.take('your-turn')
  const expected = (await thread(core, subject)).id
  t.equal(told.threadId, expected, what)
}

/** A message from Ana to me in the inbox that starts a conversation of its own. */
const fromAna = (key: string, subject: string, sentAt: string): SeedMessage => ({
  key,
  mailboxes: ['inbox'],
  from: ANA,
  to: [ME],
  subject,
  text: `${subject}.`,
  sentAt,
})

scenario('the first sync tells nothing, and a reply from a person after it is told once', async (t) => {
  const signedIn = await start(t, standardSeed(t.dialect, { pageSize: 2 }))
  const { core, box } = signedIn
  // Ana answers my answer about lunch twice in one sync: one conversation, told once.
  box.deliver({
    key: 'lunch-reply',
    mailboxes: ['inbox'],
    from: ANA,
    to: [ME],
    subject: 'Re: Lunch on Friday?',
    text: 'Great, see you at noon.',
    sentAt: '2025-12-05T09:00:00.000Z',
    replyTo: ['lunch-ask', 'lunch-answer'],
  })
  box.deliver({
    key: 'lunch-again',
    mailboxes: ['inbox'],
    from: ANA,
    to: [ME],
    subject: 'Re: Lunch on Friday?',
    text: 'Actually, can we make it 12:30?',
    sentAt: '2025-12-05T10:00:00.000Z',
    replyTo: ['lunch-ask', 'lunch-answer', 'lunch-reply'],
  })
  await sync(core)
  const told = await core.take('your-turn')
  const lunch = await thread(core, 'Lunch on Friday?')
  t.equal(
    told,
    {
      kind: 'your-turn',
      threadId: lunch.id,
      from: { name: 'Ana', address: 'ana@example.com', isMe: false },
      subject: 'Re: Lunch on Friday?',
    },
    "a reply that makes it my turn is told with its conversation, its sender and its subject, the first sync's mail not at all",
  )
  t.equal(lunch.turn, { holder: 'mine', reason: 'they-wrote-last' }, 'the conversation is my turn')
  await sentinel(t, signedIn, 'two replies in one sync tell their conversation once')
})

scenario(
  'mail from a machine, from me, outside the inbox, older than the conversation or from a resync tells nothing',
  async (t) => {
    const signedIn = await start(t)
    const { core, box } = signedIn
    box.deliver({
      key: 'offers',
      mailboxes: ['inbox'],
      from: { name: 'Shop News', address: 'news@shop.example' },
      to: [ME],
      subject: 'January offers',
      text: 'More things on sale.',
      sentAt: '2025-12-05T09:00:00.000Z',
      headers: { listUnsubscribe: true },
    })
    box.deliver({
      key: 'from-my-phone',
      mailboxes: ['sent'],
      from: ME,
      to: [ANA],
      subject: 'Dinner?',
      text: 'Dinner next week?',
      sentAt: '2025-12-05T10:00:00.000Z',
      unread: false,
    })
    // A person writes, but the message is filed away from the inbox, as a filter would.
    box.deliver(fromBen('filed', 'Project notes', '2025-12-05T11:00:00.000Z', { mailboxes: ['projects'] }))
    // A reply dated before the question it answers: the conversation is my turn, but not because of it.
    box.deliver(fromBen('late', 'Re: Can you review the draft?', '2025-12-01T08:00:00.000Z', { replyTo: ['review'] }))
    await sync(core)
    t.equal((await thread(core, 'Project notes')).turn.holder, 'mine', 'the filed message is my turn all the same')
    // A message moved into the inbox is not new. With folders it comes back under a new ref.
    box.move('filed', 'inbox')
    await sync(core)
    // A resync lists the mailbox again, with new mail in it: a snapshot, which tells nothing.
    box.expireCursors()
    box.deliver({
      key: 'resynced',
      mailboxes: ['inbox'],
      from: ANA,
      to: [ME],
      subject: 'Photos from the weekend',
      text: 'Here they are.',
      sentAt: '2025-12-06T09:00:00.000Z',
    })
    await sync(core)
    t.equal((await thread(core, 'Photos from the weekend')).turn.holder, 'mine', 'the resync brought a turn of mine')
    await sentinel(t, signedIn, 'none of them was told')
  },
)

scenario(
  'a restart catches up on the mail that came while it was down without telling it, then tells the next reply',
  async (t) => {
    const { core: first, box } = await start(t)
    await first.stop()
    box.deliver(fromAna('away', 'While you were away', '2025-12-05T09:00:00.000Z'))
    const core = t.startCore()
    await core.hello()
    await sync(core)
    const away = await thread(core, 'While you were away')
    t.equal(away.turn.holder, 'mine', 'the mail that came while the core was down is my turn')
    await sentinel(t, { core, box }, 'the catch-up told nothing, and a reply after it is told')

    // A cursor the provider no longer knows makes the next start catch up through a snapshot.
    await core.stop()
    box.expireCursors()
    box.deliver(fromAna('away-again', 'While you were away again', '2025-12-06T09:00:00.000Z'))
    const again = t.startCore()
    await again.hello()
    await sync(again)
    t.equal((await thread(again, 'While you were away again')).turn.holder, 'mine', 'the snapshot brought my turn too')
    await sentinel(
      t,
      { core: again, box },
      'the snapshot told nothing, and the change set after it tells',
      'sentinel-2',
    )
  },
)

// #31 makes a reply after Done hand the turn back. Until then Done holds, so the reply is quiet.
scenario('a reply to a conversation marked done tells nothing while done holds', async (t) => {
  const signedIn = await start(t)
  const { core, box } = signedIn
  const review = await thread(core, 'Can you review the draft?')
  const done = await core.command({ kind: 'set-turn', threadIds: [review.id], turn: 'none' })
  t.equal((await core.settled(done.change)).result, 'done', 'the conversation is marked done')
  box.deliver(
    fromBen('review-reply', 'Re: Can you review the draft?', '2025-12-05T09:00:00.000Z', { replyTo: ['review'] }),
  )
  await sync(core)
  t.equal(
    (await thread(core, 'Can you review the draft?')).turn,
    { holder: 'none', reason: 'set-by-user' },
    'done still holds after the reply',
  )
  await sentinel(t, signedIn, 'the reply to the done conversation was not told')
})
