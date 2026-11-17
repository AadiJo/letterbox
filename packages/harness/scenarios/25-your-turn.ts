// Ways a notification can bother the user for nothing, or stay quiet when it matters: mail
// from the first sync or a resync told as new, mail from a machine or from the user told,
// mail outside the inbox told, one conversation told twice, or a reply never told.
//
// The core sends `your-turn` before the answer to the sync that brought the mail, and the
// client keeps every message no wait took. So when the first `your-turn` a scenario takes is
// the one for a sentinel delivered last, nothing before it was told.

import type { Scenario } from '../src/scenario.ts'
import type { SignedIn } from '../src/fixtures.ts'
import { fromBen, ME, standardSeed, start, sync, thread } from '../src/fixtures.ts'
import { scenario } from '../src/scenario.ts'

const ANA = { name: 'Ana', address: 'ana@example.com' }

/** Delivers a message from Ben, syncs, and checks it is the next conversation told. */
async function sentinel(t: Scenario, { core, box }: SignedIn, what: string) {
  box.deliver(fromBen('sentinel', 'Are you around?', '2025-12-09T09:00:00.000Z'))
  await sync(core)
  const told = await core.take('your-turn')
  const expected = (await thread(core, 'Are you around?')).id
  t.equal(told.threadId, expected, what)
}

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
