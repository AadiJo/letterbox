// Sends whose fate the core cannot see at once, and the deadlines around a send. A provider
// offers no way to send a message only once, so a send that may have arrived is looked up
// and never sent again. Undo trusts the clock, not a timer. Each scenario fixes the order
// of events with held provider calls, held waits and a moved clock.

import { readThread, start, sync, threads } from '../src/fixtures.ts'
import { HELD_WINDOW, scenario } from '../src/scenario.ts'
import { asked, draft, idsOf, startWith } from '../src/sending.ts'

scenario('a send cut off by a crash is looked up, never sent again, and settles when its copy shows', async (t) => {
  const first = await start(t)
  const { threadId, question } = await asked(first.core)
  first.box.holdSends()
  const send = await first.core.command({ kind: 'send', draft: draft(first.accountId, question.id) })
  await first.box.sendHeld()
  await first.core.kill()
  t.equal(first.box.sent(), [], 'the provider holds the send and has filed nothing')

  // Held waits keep the next lookup back, so the scenario decides when it comes.
  const core = t.startCore({ holdWaits: true })
  await core.hello()
  await sync(core)
  t.equal(first.box.sent(), [], 'the restarted core looked it up, found nothing, and did not send it again')
  t.equal(
    (await readThread(core, threadId))?.messages[1]?.delivery?.state,
    'sending',
    'the reply waits to be confirmed',
  )

  // The first send lands after the lookup came back empty.
  first.box.releaseSends()
  t.equal(first.box.sent().length, 1, 'the provider files the first send')
  await sync(core)
  t.equal((await core.settled(send.change)).result, 'done', 'the sync that brings its copy settles it as done')
  const detail = await readThread(core, threadId)
  t.equal([detail?.messages.length, detail?.messages[1]?.delivery], [2, null], 'the conversation shows the copy once')
  t.equal([first.box.sent().length, first.box.calls().send], [1, 1], 'the provider was asked to send it once')
})

scenario('a send never found fails as unconfirmed, and a copy that turns up later takes its place', async (t) => {
  const first = await start(t)
  const { threadId, question } = await asked(first.core)
  first.box.holdSends()
  const send = await first.core.command({ kind: 'send', draft: draft(first.accountId, question.id) })
  await first.box.sendHeld()
  await first.core.kill()

  // The confirm window takes no real time, so every lookup comes back empty before the release.
  const core = t.startCore()
  await core.hello()
  await sync(core)
  t.equal(
    (await core.settled(send.change)).result,
    { failed: 'unconfirmed' },
    'it fails as unconfirmed, not as sent and not as refused',
  )
  const failed = await readThread(core, threadId)
  t.equal(
    failed?.messages[1]?.delivery,
    { state: 'failed', change: send.change, reason: 'unconfirmed' },
    'the reply stays, marked as maybe not sent',
  )
  t.equal(first.box.calls().send, 0, 'no send reached the provider beside the one it still holds')

  first.box.releaseSends()
  await sync(core)
  const after = await readThread(core, threadId)
  t.equal(idsOf(after), idsOf(failed), 'the copy the provider filed after all takes the reply’s place')
  t.equal(after?.messages[1]?.delivery, null, 'and shows as the provider’s copy')
  t.equal(
    [first.box.calls().send, first.box.sent().length, (await threads(core)).length],
    [1, 1, 5],
    'one send, one copy, no extra conversation',
  )
})

scenario(
  'on gmail, a send whose answer is lost in transit is never sent again',
  async (t) => {
    const { core, box, accountId } = await start(t)
    const { threadId, question } = await asked(core)
    box.holdSends()
    const send = await core.command({ kind: 'send', draft: draft(accountId, question.id) })
    await box.sendHeld()
    // The network fails after the request went out: Gmail drops the connection and files nothing.
    box.setOffline(true)
    box.releaseSends()
    box.setOffline(false)
    await sync(core)
    t.equal(
      (await core.settled(send.change)).result,
      { failed: 'unconfirmed' },
      'the core could not know, so it says the send may not have gone',
    )
    t.equal([box.calls().send, box.sent()], [0, []], 'no second send reached Gmail, and the first filed nothing')
    t.equal((await readThread(core, threadId))?.messages.length, 2, 'the reply stays in its conversation')
  },
  ['gmail'],
)

scenario('undo after the deadline is refused even before the window’s timer has run', async (t) => {
  // A window of nothing, and timers that never run: the clock passes the deadline at once.
  const first = await startWith(t, { undoWindow: 0, holdWaits: true })
  const { threadId, question } = await asked(first.core)
  const send = await first.core.command({ kind: 'send', draft: draft(first.accountId, question.id) })
  t.equal(
    (await readThread(first.core, threadId))?.messages[1]?.delivery?.state,
    'held',
    'its timer has not run, so it still shows as held',
  )
  const undo = await first.core.command({ kind: 'undo', change: send.change })
  t.equal(undo.kind === 'rejected' && undo.reason, 'conflict', 'the clock is past the deadline, so the undo is refused')
  await first.core.stop()

  const core = t.startCore()
  await core.hello()
  t.equal((await core.settled(send.change)).result, 'done', 'it goes out once its timer runs')
  t.equal(first.box.sent().length, 1, 'the provider got it once')
})

scenario('undo after a restart past the deadline is refused', async (t) => {
  const first = await startWith(t, { undoWindow: HELD_WINDOW })
  const { question } = await asked(first.core)
  const send = await first.core.command({ kind: 'send', draft: draft(first.accountId, question.id) })
  await first.core.stop()

  // Two hours on, past the deadline, with the timer the restart starts held back.
  const later = '2026-01-01T02:00:00.000Z'
  const second = t.startCore({ now: later, holdWaits: true })
  await second.hello()
  const undo = await second.command({ kind: 'undo', change: send.change })
  t.equal(undo.kind === 'rejected' && undo.reason, 'conflict', 'the undo is refused')
  await second.stop()

  const core = t.startCore({ now: later })
  await core.hello()
  t.equal((await core.settled(send.change)).result, 'done', 'it goes out once its timer runs')
  t.equal(first.box.sent().length, 1, 'the provider got it once')
})

scenario('a subject word too long to fold still goes out within the line limit', async (t) => {
  const { core, box, accountId } = await start(t)
  const subject = `Report ${'x'.repeat(1000)} attached`
  const send = await core.command({
    kind: 'send',
    draft: draft(accountId, null, { to: ['ana@example.com'], subject, text: 'See the subject.' }),
  })
  t.equal((await core.settled(send.change)).result, 'done', 'the provider takes it')
  const lines = (box.sent()[0]?.raw ?? '').split('\r\n')
  t.check(
    lines.every((line) => line.length <= 78),
    'no line is longer than 78 characters, let alone the 998 RFC 5322 allows',
  )
  box.expireCursors()
  await sync(core)
  const found = (await threads(core)).filter((row) => row.subject === subject)
  t.equal(found.length, 1, 'a full resync reads the same subject back')
})
