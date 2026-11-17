// An undo of a change a pass is carrying waits for it: it is answered once the change settles,
// or the pass lets go of it unsettled, by the same rules as any undo. And a change after one
// the provider has not confirmed waits for the refresh that shows what it did. Held calls,
// held snapshot pages, refusals and damaged answers fix the order of every step; a query's
// answer shows the core has read every command sent before it.

import type { ChangeId } from '@letterbox/protocol'
import { mailbox, standardSeed, start, sync, thread, truthOf } from '../src/fixtures.ts'
import { scenario } from '../src/scenario.ts'
import { accept, allTruth, targetRow } from '../src/undoing.ts'

const LUNCH = 'Lunch on Friday?'

scenario('an undo while a change of two steps is on its way waits for both, then reverses it', async (t) => {
  const { core, box } = await start(t)
  const truth = allTruth(box)
  const lunch = await thread(core, LUNCH)
  box.holdApplies()
  const trash = await accept(t, core, { kind: 'trash', threadIds: [lunch.id] }, 'the trash')
  await box.applyHeld()
  const undoing = core.command({ kind: 'undo', change: trash })
  await core.query({ view: 'accounts' })
  // Both steps go through. The undo waits for the second, not just the first.
  box.releaseApplies()
  const answer = await undoing
  t.equal(answer.kind, 'accepted', 'the undo is accepted once the trash settles')
  t.equal(
    [(await core.settled(trash)).result, (await core.settled(answer.change)).result],
    ['done', 'done'],
    'the trash and its undo both settle as done',
  )
  await sync(core)
  t.equal(allTruth(box), truth, 'the provider holds every message as it was')
  t.equal(await thread(core, LUNCH), lunch, 'the row is exactly as it was')
})

scenario('the same undo sent twice while it waits gets one answer each, and reverses once', async (t) => {
  const { core, box } = await start(t)
  const before = await targetRow(core)
  const inbox = await mailbox(core, 'Inbox')
  box.holdApplies()
  const archive = await accept(
    t,
    core,
    { kind: 'set-mailboxes', threadIds: [before.id], add: [], remove: [inbox.id] },
    'the archive',
  )
  await box.applyHeld()
  const id = 'change_undo_held' as ChangeId
  const first = core.command({ kind: 'undo', change: archive }, id)
  const second = core.command({ kind: 'undo', change: archive }, id)
  await core.query({ view: 'accounts' })
  box.releaseApplies()
  t.equal([(await first).kind, (await second).kind], ['accepted', 'accepted'], 'both are answered, accepted')
  t.equal((await core.settled(id)).result, 'done', 'the undo settles')
  await sync(core)
  t.equal(box.calls().apply, 2, 'the archive and its undo each reached the provider once')
  t.equal(await targetRow(core), before, 'the row is exactly as it was')
})

scenario('an undo that waits for a change the provider turns away is refused, as the change rolled back', async (t) => {
  const { core, box } = await start(t)
  const before = await targetRow(core)
  const inbox = await mailbox(core, 'Inbox')
  box.holdApplies()
  const archive = await accept(
    t,
    core,
    { kind: 'set-mailboxes', threadIds: [before.id], add: [], remove: [inbox.id] },
    'the archive',
  )
  await box.applyHeld()
  const undoing = core.command({ kind: 'undo', change: archive })
  await core.query({ view: 'accounts' })
  box.refuseNextApply('conflict')
  box.releaseApplies()
  const answer = await undoing
  t.equal(
    answer.kind === 'rejected' && [answer.reason, answer.conflict ?? null],
    ['conflict', null],
    'once the archive fails, nothing went through, so the undo is refused with nothing to take back',
  )
  t.equal((await core.settled(archive)).result, { failed: 'conflict' }, 'the archive settled failed')
  t.equal(await targetRow(core), before, 'the row is as it was')
})

scenario('an undo that waits for a change whose answer is lost is told the outcome is unknown', async (t) => {
  const { core, box } = await start(t)
  const before = await targetRow(core)
  const inbox = await mailbox(core, 'Inbox')
  box.holdApplies()
  const archive = await accept(
    t,
    core,
    { kind: 'set-mailboxes', threadIds: [before.id], add: [], remove: [inbox.id] },
    'the archive',
  )
  await box.applyHeld()
  const undoing = core.command({ kind: 'undo', change: archive })
  await core.query({ view: 'accounts' })
  // The provider takes it and the answer is lost, so the pass ends with the archive unsettled.
  box.damageNextApplyAnswer('disconnect')
  box.releaseApplies()
  const answer = await undoing
  t.equal(answer.kind === 'rejected' && answer.conflict, { kind: 'outcome-unknown' }, 'the undo cannot tell yet')
  await sync(core)
  t.equal((await core.settled(archive)).result, 'done', 'a sync shows the archive went through')
})

scenario(
  'a change after one that failed with part of it through waits for the whole refresh',
  async (t) => {
    // The target in 105 more labels, and two messages a snapshot page.
    const many = standardSeed(t.dialect, { pageSize: 2 })
    const labels = Array.from({ length: 105 }, (_, index) => ({
      key: `label-${index}`,
      name: `Label ${index}`,
      role: null,
    }))
    many.mailboxes.push(...labels)
    const review = many.messages.find((message) => message.key === 'review')
    if (review) review.mailboxes = ['inbox', ...labels.map((label) => label.key)]
    const { core, box } = await start(t, many)
    const before = await targetRow(core)
    // Gmail takes the trash in two requests, and turns the second away: the trash fails with
    // part of it through, and only a refresh shows which part.
    box.holdApplies()
    const trash = await accept(t, core, { kind: 'trash', threadIds: [before.id] }, 'the trash')
    await box.applyHeld()
    box.releaseApplies()
    box.refuseNextApply('conflict')
    t.equal((await core.settled(trash)).result, { failed: 'conflict' }, 'the trash settles failed')
    // The next refresh lists the mailbox page by page, and its second page waits.
    box.expireCursors()
    box.holdSnapshots()
    const flag = await accept(t, core, { kind: 'set-flags', threadIds: [before.id], flagged: true }, 'a flag')
    await box.snapshotHeld()
    box.releaseSnapshots()
    box.holdSnapshots()
    await box.snapshotHeld()
    t.equal((await targetRow(core)).pending, true, 'the flag waits while the refresh is part way')
    box.releaseSnapshots()
    t.equal((await core.settled(flag)).result, 'done', 'once the refresh ends, the flag goes')
    t.equal(truthOf(box, 'review')?.flagged, true, 'the provider has the flag')
  },
  ['gmail'],
)
