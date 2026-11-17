// Whose turn it is around a reply. The turn moves only once the provider holds the reply, so
// a reply that is held, undone, refused or never confirmed leaves Ben's question my turn.
// Held windows, held sends and held waits fix when each step happens.

import type { TurnState } from '@letterbox/protocol'
import { readThread, start, sync, thread, threads } from '../src/fixtures.ts'
import { HELD_WINDOW, scenario } from '../src/scenario.ts'
import { ASKED, asked, cutOff, draft, startWith } from '../src/sending.ts'

const MINE: TurnState = { holder: 'mine', reason: 'they-wrote-last' }
const THEIRS: TurnState = { holder: 'theirs', reason: 'i-wrote-last' }

/** Two hours on from where a fixed clock starts: past any window a scenario's first core opened. */
const LATER = '2026-01-01T02:00:00.000Z'

scenario('the turn waits for the provider while a reply is held, and an undone reply never moves it', async (t) => {
  const { core, accountId } = await startWith(t, { undoWindow: HELD_WINDOW })
  const { threadId, question } = await asked(core)
  const send = await core.command({ kind: 'send', draft: draft(accountId, question.id) })
  const held = await readThread(core, threadId)
  t.equal(
    [held?.messages[1]?.delivery?.state, held?.turn],
    ['held', MINE],
    'the reply waits in its undo window, and it is still my turn',
  )
  t.check(
    (await threads(core, { turn: 'mine' })).some((row) => row.id === threadId),
    'the conversation stays in Your turn',
  )
  await core.command({ kind: 'undo', change: send.change })
  t.equal((await core.settled(send.change)).result, 'undone', 'the send settles as undone')
  t.equal((await thread(core, ASKED)).turn, MINE, 'with the reply gone it is still my turn')
})

scenario('the turn waits for the provider, so a reply it refuses leaves the turn mine', async (t) => {
  const { core, box, accountId } = await start(t)
  const { threadId, question } = await asked(core)
  box.refuseNextSend('refused-by-provider')
  const send = await core.command({ kind: 'send', draft: draft(accountId, question.id) })
  t.equal((await core.settled(send.change)).result, { failed: 'refused-by-provider' }, 'the send fails')
  const failed = await readThread(core, threadId)
  t.equal(
    [failed?.messages[1]?.delivery?.state, failed?.turn],
    ['failed', MINE],
    'the failed reply stays, and it is still my turn',
  )
  box.expireCursors()
  await sync(core)
  t.equal((await thread(core, ASKED)).turn, MINE, 'a full resync keeps it my turn')
})

scenario(
  'the turn waits for the provider, so an unconfirmed reply leaves the turn mine until its copy shows',
  async (t) => {
    const { box, threadId, change } = await cutOff(t)
    // Held waits: the restarted core looks once, finds nothing, and keeps the send unconfirmed.
    const second = t.startCore({ holdWaits: true })
    await second.hello()
    await sync(second)
    const checking = await readThread(second, threadId)
    t.equal(
      [checking?.messages[1]?.delivery?.state, checking?.turn],
      ['sending', MINE],
      'the core cannot tell whether it went, so it is still my turn',
    )
    await second.stop()

    // Past the confirm window, the next core gives up on it.
    const core = t.startCore({ now: LATER })
    await core.hello()
    t.equal((await core.settled(change)).result, { failed: 'unconfirmed' }, 'the send fails as unconfirmed')
    t.equal((await thread(core, ASKED)).turn, MINE, 'a reply that may not have gone leaves it my turn')

    // The provider files it after all. Its copy is the proof it went.
    box.releaseSends()
    await sync(core)
    t.equal((await thread(core, ASKED)).turn, THEIRS, 'once its copy shows, the turn is theirs')
  },
)

scenario('the turn waits for the provider, and moves once it holds the reply', async (t) => {
  const { core, accountId } = await start(t)
  const { threadId, question } = await asked(core)
  t.equal((await thread(core, ASKED)).turn, MINE, 'Ben asked, so it is my turn')
  const send = await core.command({ kind: 'send', draft: draft(accountId, question.id) })
  t.equal((await core.settled(send.change)).result, 'done', 'the reply goes out')
  t.equal((await thread(core, ASKED)).turn, THEIRS, 'the provider holds it, so the turn is theirs')
  t.check(
    (await threads(core, { turn: 'theirs' })).some((row) => row.id === threadId),
    'the conversation moves to Waiting on them',
  )
})
