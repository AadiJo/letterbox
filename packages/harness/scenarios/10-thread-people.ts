// Who a conversation's row names. A row names everyone taking part, so a conversation the
// user started names the people they wrote to before anyone answers.

import { ME, start, sync, thread, threads } from '../src/fixtures.ts'
import { scenario } from '../src/scenario.ts'

scenario('a conversation I started names who I wrote to, before and after they answer', async (t) => {
  const { core, box } = await start(t)
  const dana = { name: 'Dana', address: 'dana@example.com' }
  box.deliver({
    key: 'offsite-ask',
    mailboxes: ['sent'],
    from: ME,
    to: [dana],
    subject: 'Offsite venue',
    text: 'Can you book the venue for the offsite?',
    sentAt: '2025-12-05T09:00:00.000Z',
    unread: false,
  })
  await sync(core)
  const asked = await thread(core, 'Offsite venue')
  t.equal(
    asked.people.map((who) => [who.address, who.isMe]),
    [
      [ME, true],
      [dana.address, false],
    ],
    'before an answer, the row names me and the person I wrote to',
  )
  t.equal(
    (await threads(core, { text: 'dana' })).map((item) => item.subject),
    ['Offsite venue'],
    'searching for the person I wrote to finds the conversation',
  )

  // The answer comes from the same address in other letters' case, so it must not add Dana twice.
  box.deliver({
    key: 'offsite-answer',
    mailboxes: ['inbox'],
    from: { name: 'Dana', address: 'Dana@Example.com' },
    to: [ME],
    subject: 'Re: Offsite venue',
    text: 'Booked.',
    sentAt: '2025-12-05T10:00:00.000Z',
    replyTo: ['offsite-ask'],
  })
  await sync(core)
  const answered = await thread(core, 'Offsite venue')
  t.equal(
    [answered.messageCount, answered.people.map((who) => [who.address, who.isMe])],
    [
      2,
      [
        [ME, true],
        [dana.address, false],
      ],
    ],
    'after the answer, the row still names both of us, once each',
  )
})
