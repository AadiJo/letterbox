// Where a conversation sits in a list (`position`), as a UI asks when it opens one from outside
// the rows it has loaded, as from a notification. The answer must be the conversation's index
// in the list a fresh query gives: newest first, a tie in time broken the same way, the
// retired cut where the filter asks for it, and the order as it is now, not as the asker last
// saw it. A conversation the list does not hold, or that is gone, answers null. Asking moves
// nothing: while a conversation has crossed 30 days and its wake has not run yet, the answer
// cuts where the open lists still do, and their next update is the same as if nobody asked.
// Every core here starts its fixed clock at 2026-01-01T00:00:00Z, one second on per read.

import type { ThreadFilter, ThreadId } from '@letterbox/protocol'
import type { CoreClient } from '../src/client.ts'
import { fromBen, ME, PASSWORD, signIn, standardSeed, start, sync, thread, threads } from '../src/fixtures.ts'
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

scenario('position cuts where the open lists do, and moves nothing, while a crossing waits for its wake', async (t) => {
  const box = t.mailbox(standardSeed(t.dialect))
  // Every wait holds, so no wake moves a conversation across the cut while the scenario runs.
  const core = t.startCore({ holdWaits: true })
  await core.hello()
  await signIn(t, core, ME, PASSWORD)
  await sync(core)
  // Ben's ask turns 30 days old 30 seconds after the core's clock starts.
  const crossing = '2026-01-01T00:00:30.000Z'
  box.deliver(fromBen('call', 'Can we talk tomorrow?', '2025-12-02T00:00:30.000Z'))
  await sync(core)
  const yourTurn = core.subscribe({ view: 'threads', filter: YOUR_TURN, offset: 0, limit: 50 })
  const opened = await yourTurn.next()
  const ask = opened.threads.find((listed) => listed.subject === 'Can we talk tomorrow?')
  if (!ask) throw new Error('Your turn opened without the ask')

  // A sync reads the clock and moves nothing the lists go by. Sync until it is past the crossing.
  let syncs = 0
  for (;;) {
    await sync(core)
    syncs += 1
    const [account] = await core.query({ view: 'accounts' })
    const status = account?.status
    if (status && 'lastSyncedAt' in status && status.lastSyncedAt !== null && status.lastSyncedAt > crossing) break
    if (syncs === 400) throw new Error(`400 syncs never took the clock past ${crossing}`)
  }
  t.note(`${syncs} syncs took the clock past the crossing`)

  const shown = yourTurn.latest()?.threads.map((listed) => listed.id) ?? []
  t.equal(
    [shown.includes(ask.id), await positionOf(core, YOUR_TURN, ask.id), await positionOf(core, LET_GO, ask.id)],
    [true, shown.indexOf(ask.id), null],
    'past the crossing, before its wake, position puts the ask where the open Your turn still shows it',
  )

  // A commit after the queries answers the open list again, at the time it goes by.
  box.deliver(fromBen('lunch', 'Lunch next week?', '2025-12-31T09:00:00.000Z'))
  await sync(core)
  const after = yourTurn.latest()?.threads.map((listed) => listed.subject) ?? []
  t.equal(
    [after.includes('Lunch next week?'), after.includes('Can we talk tomorrow?')],
    [true, true],
    "Your turn's next update still holds the ask: asking where it sits moved nothing",
  )
})
