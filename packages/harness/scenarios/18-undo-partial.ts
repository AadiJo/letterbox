// Undo of a change the provider took only part of, or never said: a step turned away after
// another went through, a request turned away after an earlier one of the same step did, a
// mailbox gone while its messages stay, a call that never landed, a lost move. An undo trusts
// only what the provider confirmed, so it waits for a sync, then takes back all or nothing.
// Held calls, refusals, damaged answers and offline turns fix the order of every step.

import type { ChangeId } from '@letterbox/protocol'
import type { Seed } from '@letterbox/sim-provider/contract'
import type { CoreClient } from '../src/client.ts'
import { mailbox, standardSeed, start, sync, thread, truthOf } from '../src/fixtures.ts'
import { type Scenario, scenario } from '../src/scenario.ts'
import { accept, allTruth, targetRow } from '../src/undoing.ts'

const LUNCH = 'Lunch on Friday?'

/** `seed` with the message `key` in `mailboxes` instead. */
const filed = (seed: Seed, key: string, mailboxes: string[]): Seed => ({
  ...seed,
  messages: seed.messages.map((message) => (message.key === key ? { ...message, mailboxes } : message)),
})

/** The standard seed with the target message in Inbox and 105 more labels: Gmail takes two requests to trash it. */
function manyLabels(t: Scenario): Seed {
  const seed = standardSeed(t.dialect)
  const labels = Array.from({ length: 105 }, (_, index) => ({
    key: `label-${index}`,
    name: `Label ${index}`,
    role: null,
  }))
  const filedIn = filed(seed, 'review', ['inbox', ...labels.map((label) => label.key)])
  return { ...filedIn, mailboxes: [...seed.mailboxes, ...labels] }
}

/** What the core answers an undo of `change` with: `accepted`, or the reason it was refused. */
async function undoAnswer(core: CoreClient, change: ChangeId) {
  const answer = await core.command({ kind: 'undo', change })
  return answer.kind === 'accepted' ? 'accepted' : (answer.conflict?.kind ?? answer.reason)
}

scenario('a partly refused trash waits for a sync, then is refused as partly applied', async (t) => {
  const { core, box } = await start(t)
  const lunch = await thread(core, LUNCH)
  // The answer's step goes first and the question's second: two steps.
  box.holdApplies()
  const trash = await accept(t, core, { kind: 'trash', threadIds: [lunch.id] }, 'the trash')
  await box.applyHeld()
  // The first step goes through, and the provider turns the second away.
  box.releaseApplies()
  box.refuseNextApply('conflict')
  t.equal((await core.settled(trash)).result, { failed: 'conflict' }, 'it settles failed')
  t.equal(await undoAnswer(core, trash), 'outcome-unknown', 'its undo waits for a sync')
  await sync(core)
  t.equal(await undoAnswer(core, trash), 'partly-applied', 'after the sync, its undo is refused as partly applied')
  t.equal(
    [truthOf(box, 'lunch-answer')?.mailboxes.includes('trash'), truthOf(box, 'lunch-ask')?.mailboxes],
    [true, ['inbox']],
    'the provider keeps the step that went through, and nothing undid it',
  )
})

scenario(
  'a step that names a mailbox deleted at the provider is turned away, not taken for gone',
  async (t) => {
    const { core, box } = await start(t, filed(standardSeed(t.dialect), 'lunch-ask', ['inbox', 'projects']))
    const lunch = await thread(core, LUNCH)
    // The answer's step, Trash, goes first. The question's takes it out of Inbox and Projects,
    // and Projects is deleted before it goes.
    box.setOffline(true)
    const trash = await accept(t, core, { kind: 'trash', threadIds: [lunch.id] }, 'the trash')
    box.deleteMailbox('projects')
    box.setOffline(false)
    await sync(core)
    t.equal(
      (await core.settled(trash)).result,
      { failed: t.gmail ? 'refused-by-provider' : 'unknown-target' },
      'it settles failed, though its messages are all there',
    )
    t.equal(await undoAnswer(core, trash), 'partly-applied', 'its undo is refused as partly applied')
  },
  ['labels', 'gmail'],
)

scenario(
  'a gmail step turned away after an earlier request went through is never undone, even after another client moves it',
  async (t) => {
    const { core, box } = await start(t, manyLabels(t))
    const before = await targetRow(core)
    box.holdApplies()
    const trash = await accept(t, core, { kind: 'trash', threadIds: [before.id] }, 'the trash')
    await box.applyHeld()
    // Gmail takes at most 100 labels off in one request, so the one step is two requests. The
    // first goes through, and Gmail turns the second away.
    box.releaseApplies()
    box.refuseNextApply('conflict')
    t.equal((await core.settled(trash)).result, { failed: 'conflict' }, 'it settles failed')
    t.equal(await undoAnswer(core, trash), 'outcome-unknown', 'its undo waits for a sync')
    await sync(core)
    t.equal(await undoAnswer(core, trash), 'partly-applied', 'after the sync, its undo is refused')
    // Another client files it in Projects. The undo must never put the old labels back.
    box.move('review', 'projects')
    await sync(core)
    t.equal(await undoAnswer(core, trash), 'partly-applied', 'after the move, its undo is still refused')
    t.equal(truthOf(box, 'review')?.mailboxes, ['projects'], 'the message stays where the other client put it')
  },
  ['gmail'],
)

scenario('a step that never went through is never reversed, even after another client moves its message', async (t) => {
  const { core, box } = await start(t)
  const lunch = await thread(core, LUNCH)
  box.holdApplies()
  const trash = await accept(t, core, { kind: 'trash', threadIds: [lunch.id] }, 'the trash')
  await box.applyHeld()
  // The answer's step goes through. The question's finds the provider offline and never arrives.
  box.releaseApplies()
  box.setOffline(true)
  t.equal((await core.request({ method: 'sync-now' })).ok, false, 'the provider is offline')
  // Back online, the provider turns the trash away, before the question's step went through.
  box.setOffline(false)
  box.refuseNextApply('conflict')
  await sync(core)
  t.equal((await core.settled(trash)).result, { failed: 'conflict' }, 'it settles failed')
  box.move('lunch-ask', 'projects')
  await sync(core)
  t.equal(await undoAnswer(core, trash), 'partly-applied', 'its undo is refused as partly applied')
  t.equal(truthOf(box, 'lunch-ask')?.mailboxes, ['projects'], 'the question stays where the other client put it')
})

scenario(
  'an undo whose reversal gmail took only part of leaves no undo that settles without the provider',
  async (t) => {
    const { core, box } = await start(t, manyLabels(t))
    const before = await targetRow(core)
    const trash = await accept(t, core, { kind: 'trash', threadIds: [before.id] }, 'the trash')
    t.equal((await core.settled(trash)).result, 'done', 'the trash settles')
    // Its undo puts 106 labels back: two requests. The first goes through, the second is turned away.
    box.holdApplies()
    const undo = await accept(t, core, { kind: 'undo', change: trash }, 'the undo')
    await box.applyHeld()
    box.releaseApplies()
    box.refuseNextApply('conflict')
    t.equal((await core.settled(undo)).result, { failed: 'conflict' }, 'the undo settles failed')
    t.equal(await undoAnswer(core, trash), 'outcome-unknown', 'another undo waits for a sync')
    await sync(core)
    t.equal(await undoAnswer(core, trash), 'changed', 'after the sync, it is refused: the trash no longer holds')
    const row = await targetRow(core)
    t.equal(row.mailboxIds.length, truthOf(box, 'review')?.mailboxes.length, 'the row shows what Gmail holds')
  },
  ['gmail'],
)

scenario('a change whose call never landed settles failed once a sync shows it, never done', async (t) => {
  const first = await start(t)
  const { box } = first
  const truth = allTruth(box)
  const before = await targetRow(first.core)
  const inbox = await mailbox(first.core, 'Inbox')
  box.holdApplies()
  const archive = await accept(
    t,
    first.core,
    { kind: 'set-mailboxes', threadIds: [before.id], add: [], remove: [inbox.id] },
    'the archive',
  )
  await box.applyHeld()
  await first.core.kill()
  // The provider goes away before it answers, so the archive never lands.
  box.setOffline(true)
  box.releaseApplies()
  box.setOffline(false)

  const core = t.startCore()
  await core.hello()
  await sync(core)
  t.equal(
    (await core.settled(archive)).result,
    { failed: 'unconfirmed' },
    'the sync shows none of it, so it settles failed',
  )
  t.equal(await undoAnswer(core, archive), 'conflict', 'nothing went through, so there is nothing to undo')
  t.equal(await targetRow(core), before, 'the row is as it was')
  t.equal(allTruth(box), truth, 'the provider holds every message as it was')
})

scenario('a lost move settles from the whole refresh, and its undo waits for that', async (t) => {
  // Two messages a page, so a snapshot lists the target on its second page.
  const { core, box } = await start(t, standardSeed(t.dialect, { pageSize: 2 }))
  const truth = allTruth(box)
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
  // The provider takes it and the answer is lost. Offline, nothing shows what became of it yet.
  box.damageNextApplyAnswer('disconnect')
  box.releaseApplies()
  box.setOffline(true)
  t.equal((await core.request({ method: 'sync-now' })).ok, false, 'the provider is offline')
  // The provider forgets every cursor, so the next sync lists the mailbox page by page. With
  // folders the move gave the target a new ref, which only its page tells the core.
  box.expireCursors()
  t.equal(await undoAnswer(core, archive), 'outcome-unknown', 'its undo waits for the provider')
  // A flag made meanwhile names the same message, so it waits for the refresh too.
  const flag = await accept(t, core, { kind: 'set-flags', threadIds: [before.id], flagged: true }, 'a flag')
  box.setOffline(false)
  await sync(core)
  t.equal(
    [(await core.settled(archive)).result, (await core.settled(flag)).result],
    ['done', 'done'],
    'the whole refresh shows the archive went through, and the flag goes after it',
  )
  const undo = await accept(t, core, { kind: 'undo', change: archive }, 'the undo')
  t.equal((await core.settled(undo)).result, 'done', 'the undo settles')
  await sync(core)
  t.equal(await targetRow(core), { ...before, flagged: true }, 'the row is as it was, and flagged')
  const flagged = structuredClone(truth)
  const target = flagged.find((message) => message.key === 'review')
  if (target) target.flagged = true
  t.equal(allTruth(box), flagged, 'the provider holds every message as it was, the target flagged')
})

scenario('a change after one whose answer never came goes once a pull shows what became of it', async (t) => {
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
  box.damageNextApplyAnswer('disconnect')
  box.releaseApplies()
  box.setOffline(true)
  t.equal((await core.request({ method: 'sync-now' })).ok, false, 'the provider is offline')
  box.setOffline(false)
  // No sync asked: the flag's own pass pulls first, since the archive's answer never came.
  const flag = await accept(t, core, { kind: 'set-flags', threadIds: [before.id], flagged: true }, 'a flag')
  t.equal(
    [(await core.settled(archive)).result, (await core.settled(flag)).result],
    ['done', 'done'],
    'the pull shows the archive went through, and the flag goes after it',
  )
})
