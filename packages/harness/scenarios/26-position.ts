// Where a conversation sits in a list (`position`), as a UI asks when it opens one from outside
// the rows it has loaded, as from a notification. The answer must be the conversation's index
// in the list a fresh query gives: newest first, a tie in time broken the same way, the
// retired cut where the filter asks for it, and the order as it is now, not as the asker last
// saw it. A conversation the list does not hold, or that is gone, answers null. Every core
// here starts its fixed clock at 2026-01-01T00:00:00Z.

import type { ThreadFilter, ThreadId } from '@letterbox/protocol'
import type { CoreClient } from '../src/client.ts'
import { fromBen, start, sync, thread, threads } from '../src/fixtures.ts'
import { scenario, type Scenario } from '../src/scenario.ts'

const ALL_MAIL: ThreadFilter = {}
const YOUR_TURN: ThreadFilter = { turn: 'mine', retired: false }
const LET_GO: ThreadFilter = { turn: 'mine', retired: true }

/** The core's answer to `position`. */
async function positionOf(core: CoreClient, filter: ThreadFilter, threadId: ThreadId) {
  const answer = await core.request({ method: 'position', filter, threadId })
  if (!answer.ok) throw new Error('position cannot fail')
  return answer.result.offset
}

/** Checks that every conversation's position in the list over `filter` is its index there. */
async function agrees(t: Scenario, core: CoreClient, filter: ThreadFilter, name: string) {
  const list = await core.query({ view: 'threads', filter, offset: 0, limit: 500 })
  const answered = await Promise.all(list.threads.map((listed) => positionOf(core, filter, listed.id)))
  t.equal(
    answered,
    list.threads.map((_, index) => index),
    `${name}: each conversation's position is its index in the list`,
  )
}

scenario('position says where a conversation sits now, with ties and the retired cut', async (t) => {
  const { core, box } = await start(t)
  // Two conversations whose newest messages carry the same time.
  box.deliver(fromBen('tie-one', 'Tie one', '2025-12-20T09:00:00.000Z'))
  box.deliver(fromBen('tie-two', 'Tie two', '2025-12-20T09:00:00.000Z'))
  await sync(core)
  const tied = (await threads(core)).filter((listed) => listed.subject.startsWith('Tie'))
  t.equal(
    tied.map((listed) => listed.lastMessageAt),
    ['2025-12-20T09:00:00.000Z', '2025-12-20T09:00:00.000Z'],
    'two conversations end at the same time',
  )
  await agrees(t, core, ALL_MAIL, 'All mail')
  await agrees(t, core, YOUR_TURN, 'Your turn')
  await agrees(t, core, LET_GO, 'Let go?')

  // Ana's photos, 42 days old, wait in Let go?. Ben then answers in that conversation: a
  // UI that last saw the photos at their old time still gets their place now.
  const photos = await thread(core, 'Trip photos')
  const before = {
    all: await positionOf(core, ALL_MAIL, photos.id),
    letGo: await positionOf(core, LET_GO, photos.id),
    yourTurn: await positionOf(core, YOUR_TURN, photos.id),
  }
  t.equal(
    [before.all !== null && before.all > 0, before.letGo !== null, before.yourTurn],
    [true, true, null],
    'the photos sit below the top of All mail, in Let go?, and not in Your turn',
  )
  box.deliver(fromBen('photos-reply', 'Re: Trip photos', '2025-12-31T09:00:00.000Z', { replyTo: ['photos'] }))
  await sync(core)
  t.equal(
    [
      await positionOf(core, ALL_MAIL, photos.id),
      await positionOf(core, YOUR_TURN, photos.id),
      await positionOf(core, LET_GO, photos.id),
    ],
    [0, 0, null],
    "after Ben's answer the photos are first in All mail and in Your turn, and out of Let go?",
  )
  await agrees(t, core, ALL_MAIL, 'after the answer, All mail')
  await agrees(t, core, LET_GO, 'after the answer, Let go?')

  // A conversation that is gone is in no list.
  const gone = tied[0]
  if (!gone) throw new Error('no tied conversation')
  box.expunge('tie-one')
  box.expunge('tie-two')
  await sync(core)
  t.equal(await positionOf(core, ALL_MAIL, gone.id), null, 'a conversation that is gone has no position')
})
