// How a send that may have reached the provider recovers: an answer that comes back damaged,
// a lookup that fails, a restart while the core is still looking, a copy that a sync finds
// before the provider's search does. Each scenario fixes the order of events with held
// provider calls, held waits and a moved clock.

import { fromBen, readThread, start, standardSeed, sync, thread, threads } from '../src/fixtures.ts'
import { scenario } from '../src/scenario.ts'
import { cutOff, draft, idsOf } from '../src/sending.ts'

/** Two hours on from where a fixed clock starts: past any window a scenario's first core opened. */
const LATER = '2026-01-01T02:00:00.000Z'

scenario('a send whose answer comes back damaged is looked up, never sent again', async (t) => {
  const { core, box, accountId } = await start(t)
  for (const how of ['disconnect', 'truncated', 'invalid-json'] as const) {
    box.damageNextSendAnswer(how)
    const subject = `Answer ${how}`
    const send = await core.command({ kind: 'send', draft: draft(accountId, null, { subject }) })
    t.equal((await core.settled(send.change)).result, 'done', `${how}: the copy is found and it settles as done`)
    t.equal((await thread(core, subject)).messageCount, 1, `${how}: its conversation shows it once`)
  }
  t.equal([box.calls().send, box.sent().length], [3, 3], 'each was sent once')
})

scenario('a lookup that fails is tried again, and the send settles once its copy is found', async (t) => {
  const { box, change } = await cutOff(t)
  box.releaseSends()
  box.failNextFind()
  // No sync: the restart looks once and fails, so only the check that failure books can find it.
  const core = t.startCore()
  await core.hello()
  t.equal((await core.settled(change)).result, 'done', 'the next lookup finds the copy')
  t.equal([box.calls().send, box.calls().find >= 2], [1, true], 'it was sent once, and looked up again')
})

scenario('a restart while a send is unconfirmed picks its lookups up again', async (t) => {
  const { box, threadId, change } = await cutOff(t)
  // Held waits: the second core looks once, finds nothing, and its next lookup never comes.
  const second = t.startCore({ holdWaits: true })
  await second.hello()
  await sync(second)
  await second.stop()
  box.releaseSends()

  // Its clock starts over, so this core starts before the window the second one saved has ended.
  const core = t.startCore()
  await core.hello()
  t.equal((await core.settled(change)).result, 'done', 'with no sync, the restarted core looks again and finds it')
  t.equal((await readThread(core, threadId))?.messages.length, 2, 'the conversation shows it once')
})

scenario('a restart after an unconfirmed send’s window ended fails it at once', async (t) => {
  const { box, threadId, change } = await cutOff(t)
  const second = t.startCore({ holdWaits: true })
  await second.hello()
  await sync(second)
  await second.stop()

  const core = t.startCore({ now: LATER })
  await core.hello()
  t.equal(
    (await core.settled(change)).result,
    { failed: 'unconfirmed' },
    'with no sync, the restarted core looks once more, finds nothing, and gives up',
  )
  box.releaseSends()
  await sync(core)
  t.equal((await readThread(core, threadId))?.messages.length, 2, 'a copy that lands later still shows once')
})

scenario('a copy a sync finds while lookups still miss it settles the send as done, once', async (t) => {
  const { box, threadId, change } = await cutOff(t)
  box.releaseSends()
  box.setSearchLag(true)
  // Held waits: every lookup the second core makes finds nothing, and none comes on a timer.
  const second = t.startCore({ holdWaits: true })
  await second.hello()
  await sync(second)
  t.equal((await second.settled(change)).result, 'done', 'the sync finds the copy, and the send is done')
  const before = idsOf(await readThread(second, threadId))
  await second.stop()

  // Past its window, with the search still lagging: the send stays done and is not failed.
  const core = t.startCore({ now: LATER })
  await core.hello()
  await sync(core)
  t.equal(idsOf(await readThread(core, threadId)), before, 'the conversation still shows it once')
  t.equal(box.calls().send, 1, 'it was sent once')
})

scenario('a reply to a message with a very long Message-ID keeps it as In-Reply-To', async (t) => {
  const { core, box, accountId } = await start(t)
  const parentId = `${'a'.repeat(950)}@sim.test`
  box.deliver(fromBen('long-id', 'A long id', '2025-12-05T09:00:00.000Z', { messageId: parentId }))
  await sync(core)
  const row = await thread(core, 'A long id')
  const question = (await readThread(core, row.id))?.messages[0]
  if (!question) throw new Error('the message with a long id did not arrive')
  const send = await core.command({ kind: 'send', draft: draft(accountId, question.id, { subject: 'Re: A long id' }) })
  t.equal((await core.settled(send.change)).result, 'done', 'the reply goes out')
  const lines = (box.sent()[0]?.raw ?? '').split('\r\n')
  t.check(lines.includes(`In-Reply-To: <${parentId}>`), 'In-Reply-To names the parent, however long its id')
  t.check(
    lines.every((line) => line.length <= 998),
    'no line is longer than 998 characters',
  )
  box.expireCursors()
  await sync(core)
  t.equal((await thread(core, 'A long id')).messageCount, 2, 'a full resync keeps the reply in its conversation')
})

scenario(
  'on gmail, an account added while every other account is offline can still be reached',
  async (t) => {
    const away = t.mailbox(standardSeed(t.dialect, { address: 'away@sim.test' }))
    away.setOffline(true)
    const { core } = await start(t)
    t.equal((await threads(core)).length, 5, 'the new account signs in and syncs')
  },
  ['gmail'],
)
