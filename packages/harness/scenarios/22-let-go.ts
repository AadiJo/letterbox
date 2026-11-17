// Let go?: a conversation where it has been my turn for 30 days leaves Your turn for Let go?.
// The core's clock decides, so a turn crosses while the core runs, with no command and no
// restart. Letting it go hands the turn to nobody, which takes it out of both lists, and the
// core's undo brings it back. Every core here starts its fixed clock at 2026-01-01T00:00:00Z.

import type { ThreadFilter, ThreadPage, ThreadSummary, TurnState } from '@letterbox/protocol'
import type { Dialect, Seed } from '@letterbox/sim-provider/contract'
import { fromBen, start, standardSeed, sync, threads } from '../src/fixtures.ts'
import { scenario, type Scenario } from '../src/scenario.ts'
import type { CoreClient } from '../src/client.ts'

const YOUR_TURN: ThreadFilter = { turn: 'mine', retired: false }
const LET_GO: ThreadFilter = { turn: 'mine', retired: true }

const subjects = (page: ThreadPage | undefined) => (page?.threads ?? []).map((thread) => thread.subject)

/** Opens Your turn and Let go?, and checks both after each step against lists opened afresh. */
async function openBoth(t: Scenario, core: CoreClient) {
  const open = (filter: ThreadFilter) => core.subscribe({ view: 'threads', filter, offset: 0, limit: 50 })
  const yourTurn = open(YOUR_TURN)
  const letGo = open(LET_GO)
  const [firstYours, firstLetGo] = await Promise.all([yourTurn.next(), letGo.next()])
  return {
    /** What each list showed when it opened. */
    first: { yourTurn: subjects(firstYours), letGo: subjects(firstLetGo) },
    /** Fails unless both open lists show what new ones would. Returns their subjects. */
    agree: async (when: string) => {
      for (const [name, filter, list] of [
        ['Your turn', YOUR_TURN, yourTurn],
        ['Let go?', LET_GO, letGo],
      ] as const) {
        const fresh = await core.query({ view: 'threads', filter, offset: 0, limit: 50 })
        t.equal(list.latest(), fresh, `${when}: the open ${name} list shows what a new one would`)
      }
      return { yourTurn: subjects(yourTurn.latest()), letGo: subjects(letGo.latest()) }
    },
  }
}

scenario('a turn crosses 30 days while the core runs, and moves from Your turn to Let go', async (t) => {
  const { core, box } = await start(t)
  // Ben's ask is ten minutes short of 30 days old. No list that splits on age is open yet.
  box.deliver(fromBen('call', 'Can we talk tomorrow?', '2025-12-02T00:10:00.000Z'))
  await sync(core)

  // Opening Your turn books a wake for when the ask turns 30 days old. A wait under an hour
  // ends at once on core-sim's clock, which then reads the time it waited for. The scenario
  // sends nothing more, so only the wake can move the ask.
  const yourTurn = core.subscribe({ view: 'threads', filter: YOUR_TURN, offset: 0, limit: 50 })
  t.equal(
    subjects(await yourTurn.next()),
    ['Can you review the draft?', 'Can we talk tomorrow?'],
    "Your turn opens with the ask and with Ben's review, which is nine hours short of 30 days",
  )
  const opened = yourTurn.rev()
  t.equal(
    subjects(await yourTurn.next()),
    ['Can you review the draft?'],
    'Your turn loses the ask once it turns 30 days old',
  )
  t.equal(yourTurn.rev(), opened, 'no commit came between: the clock alone moved it')

  const letGo = core.subscribe({ view: 'threads', filter: LET_GO, offset: 0, limit: 50 })
  t.equal(
    subjects(await letGo.next()),
    ['Can we talk tomorrow?', 'Trip photos'],
    "the ask is in Let go?, with Ana's archived photos, 42 days old",
  )
  for (const [name, filter, list] of [
    ['Your turn', YOUR_TURN, yourTurn],
    ['Let go?', LET_GO, letGo],
  ] as const) {
    const fresh = await core.query({ view: 'threads', filter, offset: 0, limit: 50 })
    t.equal(list.latest(), fresh, `the open ${name} list shows what a new one would`)
  }
  t.equal(
    (await threads(core, { turn: 'mine' })).map((thread) => thread.subject),
    ['Can you review the draft?', 'Can we talk tomorrow?', 'Trip photos'],
    'a list that leaves out retired lists every turn of mine, as it always has',
  )
})

/** The standard mailbox, whose photos from Ana are 42 days old, with two more asks of mine over 30 days old: Ben's on Nov 1, Ana's on Oct 20. */
function oldAsksSeed(dialect: Dialect): Seed {
  const seed = standardSeed(dialect)
  return {
    ...seed,
    messages: [
      ...seed.messages,
      fromBen('coffee', 'Coffee next week?', '2025-11-01T09:00:00.000Z'),
      {
        ...fromBen('bike', 'Still selling the bike?', '2025-10-20T09:00:00.000Z'),
        from: { name: 'Ana', address: 'ana@example.com' },
      },
    ],
  }
}

const turnOf = (thread: ThreadSummary | undefined) => thread?.turn

scenario('letting turns go takes them out of Your turn and Let go, and undo brings them back', async (t) => {
  const { core } = await start(t, oldAsksSeed(t.dialect))
  const { first, agree } = await openBoth(t, core)
  const before = await agree('synced')
  t.equal(first, before, 'each list opened showing what it shows now')
  t.equal(
    before,
    {
      yourTurn: ['Can you review the draft?'],
      letGo: ['Trip photos', 'Coffee next week?', 'Still selling the bike?'],
    },
    'the three old asks are in Let go?, newest first, and only the review is in Your turn',
  )
  const old = await threads(core, LET_GO)
  const threadIds = old.map((thread) => thread.id)

  // Let go of all three at once, as "Mark all done" does: one turn change for every conversation.
  const letGo = await core.command({ kind: 'set-turn', threadIds, turn: 'none' })
  if (letGo.kind !== 'accepted') throw new Error(`letting go was rejected: ${letGo.reason}`)
  t.equal((await core.settled(letGo.change)).result, 'done', 'letting go settles at once')
  t.equal(
    await agree('let go'),
    { yourTurn: ['Can you review the draft?'], letGo: [] },
    'all three leave Let go? and none goes to Your turn',
  )
  const after = await threads(core)
  t.equal(
    threadIds.map((id) => turnOf(after.find((thread) => thread.id === id))),
    threadIds.map((): TurnState => ({ holder: 'none', reason: 'set-by-user' })),
    "each is nobody's turn, set by the user",
  )

  const undo = await core.command({ kind: 'undo', change: letGo.change })
  t.equal(undo.kind, 'accepted', 'the undo is accepted')
  t.equal((await core.settled(undo.change)).result, 'done', 'the undo settles at once')
  t.equal(await agree('undone'), before, 'all three are back in Let go?, and Your turn is as it was')
  await sync(core)
  t.equal(await agree('synced again'), before, 'a sync keeps them there')
})
