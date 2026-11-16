// Undo across the moments a change can be caught in: on its way to the provider, part way
// there, waiting behind another change, and on either side of a restart. The order of every
// step is fixed by what the core and the sim provider report, never by time.

import { mailbox, start, sync, thread, truthOf } from '../src/fixtures.ts'
import { scenario } from '../src/scenario.ts'
import { accept, allTruth, lunchSeed, targetRow } from '../src/undoing.ts'

scenario('an undo that lands while the change is on its way reverses it once it arrives', async (t) => {
  const { core, box } = await start(t)
  const truth = allTruth(box)
  const before = await targetRow(core)
  const inbox = await mailbox(core, 'Inbox')
  box.holdApplies()
  const change = await accept(
    t,
    core,
    { kind: 'set-mailboxes', threadIds: [before.id], add: [], remove: [inbox.id] },
    'the archive',
  )
  await box.applyHeld()
  // The provider may already hold it, so the undo cannot cancel it. It follows it instead.
  const undo = await accept(t, core, { kind: 'undo', change }, 'the undo')
  box.releaseApplies()
  t.equal(
    [(await core.settled(change)).result, (await core.settled(undo)).result],
    ['done', 'done'],
    'the archive and its undo both settle as done',
  )
  await sync(core)
  t.equal(await targetRow(core), before, 'the row is exactly as it was')
  t.equal(allTruth(box), truth, 'the provider holds every message as it was')
  t.equal(box.calls().apply, 2, 'the archive and its undo each reached the provider once')
})

scenario('an undo after a restart cancels a change still waiting for the provider', async (t) => {
  const first = await start(t)
  const truth = allTruth(first.box)
  const before = await targetRow(first.core)
  const inbox = await mailbox(first.core, 'Inbox')
  first.box.setOffline(true)
  const change = await accept(
    t,
    first.core,
    { kind: 'set-mailboxes', threadIds: [before.id], add: [], remove: [inbox.id] },
    'the archive',
  )
  await first.core.stop()

  const core = t.startCore()
  await core.hello()
  // Answers once the restarted core's pass has ended, so no call for the archive is in flight.
  t.equal((await core.request({ method: 'sync-now' })).ok, false, 'the provider is still offline')
  t.equal((await targetRow(core)).pending, true, 'the archive is still waiting after the restart')
  const undo = await accept(t, core, { kind: 'undo', change }, 'the undo')
  t.equal(
    [(await core.settled(change)).result, (await core.settled(undo)).result],
    ['undone', 'done'],
    'the archive settles as undone and the undo as done',
  )
  first.box.setOffline(false)
  await sync(core)
  t.equal(await targetRow(core), before, 'the row is exactly as it was')
  t.equal(first.box.calls().apply, 0, 'the provider was never asked to archive it')
  t.equal(allTruth(first.box), truth, 'the provider holds every message as it was')
})

scenario('an undo after a restart reverses a change the provider already holds', async (t) => {
  const first = await start(t)
  const truth = allTruth(first.box)
  const before = await targetRow(first.core)
  const change = await accept(t, first.core, { kind: 'trash', threadIds: [before.id] }, 'the trash')
  t.equal((await first.core.settled(change)).result, 'done', 'it settles')
  await first.core.stop()

  const core = t.startCore()
  await core.hello()
  await sync(core)
  const undo = await accept(t, core, { kind: 'undo', change }, 'the undo')
  t.equal((await core.settled(undo)).result, 'done', 'the undo settles')
  await sync(core)
  t.equal(await targetRow(core), before, 'the row is exactly as it was')
  t.equal(allTruth(first.box), truth, 'the provider holds every message as it was')
})

scenario('an undo accepted before a restart still reaches the provider after it', async (t) => {
  const first = await start(t)
  const truth = allTruth(first.box)
  const before = await targetRow(first.core)
  const change = await accept(
    t,
    first.core,
    { kind: 'set-flags', threadIds: [before.id], unread: false, flagged: true },
    'reading and flagging',
  )
  t.equal((await first.core.settled(change)).result, 'done', 'it settles')
  first.box.setOffline(true)
  const undo = await accept(t, first.core, { kind: 'undo', change }, 'the undo')
  t.equal((await targetRow(first.core)).pending, true, 'the undo shows at once, waiting for the provider')
  await first.core.stop()
  first.box.setOffline(false)

  const core = t.startCore()
  await core.hello()
  await sync(core)
  t.equal((await core.settled(undo)).result, 'done', 'the undo settles once the provider is reachable')
  t.equal(await targetRow(core), before, 'the row is exactly as it was')
  t.equal(allTruth(first.box), truth, 'the provider holds every message as it was')
})

scenario('an undo of a change waiting behind another on its way keeps it from the provider', async (t) => {
  const { core, box } = await start(t)
  const before = await targetRow(core)
  const inbox = await mailbox(core, 'Inbox')
  box.setOffline(true)
  const flag = await accept(t, core, { kind: 'set-flags', threadIds: [before.id], flagged: true }, 'flagging')
  const archive = await accept(
    t,
    core,
    { kind: 'set-mailboxes', threadIds: [before.id], add: [], remove: [inbox.id] },
    'the archive',
  )
  t.equal((await core.request({ method: 'sync-now' })).ok, false, 'both wait while the provider is offline')
  box.setOffline(false)
  box.holdApplies()
  // One pass takes both, in order. The flag is on its way while the archive waits behind it.
  const synced = core.request({ method: 'sync-now' })
  await box.applyHeld()
  const undo = await accept(t, core, { kind: 'undo', change: archive }, 'the undo of the archive')
  t.equal((await core.settled(archive)).result, 'undone', 'the archive settles as undone')
  box.releaseApplies()
  t.equal((await synced).ok, true, 'the pass ends')
  t.equal(
    [(await core.settled(flag)).result, (await core.settled(undo)).result],
    ['done', 'done'],
    'the flag and the undo settle',
  )
  t.equal(box.calls().apply, 1, 'only the flag reached the provider')
  t.equal(
    truthOf(box, 'review'),
    { key: 'review', mailboxes: ['inbox'], unread: true, flagged: true },
    'it is flagged and still in Inbox',
  )
})

scenario(
  'an undo after part of a change reached the provider reverses that part too',
  async (t) => {
    const { core, box } = await start(t, lunchSeed(t.dialect))
    const truth = allTruth(box)
    const lunch = await thread(core, 'Lunch on Friday?')
    // Its messages sit in three folders, so the trash is three moves, one call each.
    box.holdApplies()
    const trash = await accept(t, core, { kind: 'trash', threadIds: [lunch.id] }, 'the trash')
    await box.applyHeld()
    box.releaseApplies()
    box.holdApplies()
    await box.applyHeld()
    // The first move landed. The provider goes away before the second does, which ends the pass.
    box.setOffline(true)
    box.releaseApplies()
    t.equal((await core.request({ method: 'sync-now' })).ok, false, 'the provider is offline')
    t.equal((await thread(core, 'Lunch on Friday?')).pending, true, 'the trash waits for the rest')
    const undo = await accept(t, core, { kind: 'undo', change: trash }, 'the undo')
    box.setOffline(false)
    await sync(core)
    t.equal([(await core.settled(trash)).result, (await core.settled(undo)).result], ['done', 'done'], 'both settle')
    await sync(core)
    t.equal(allTruth(box), truth, 'every message is back where it was, the one that moved first too')
    t.equal(await thread(core, 'Lunch on Friday?'), lunch, 'the row is exactly as it was')
  },
  ['folders'],
)
