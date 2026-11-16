// Undo of a change the provider took only part of: a step turned away after another went
// through, a request turned away after an earlier one of the same step did, a mailbox gone
// while its messages stay, and a lost move that must wait for a whole refresh before it goes
// again. Held calls, refusals, damaged answers and offline turns fix the order of every step.

import type { ThreadSummary } from '@letterbox/protocol'
import type { Seed } from '@letterbox/sim-provider/contract'
import { mailbox, standardSeed, start, sync, thread, truthOf } from '../src/fixtures.ts'
import { scenario } from '../src/scenario.ts'
import { accept, allTruth, targetRow } from '../src/undoing.ts'

const LUNCH = 'Lunch on Friday?'

/** A row with its mailboxes in one order, for a provider that lists them in its own. */
const sorted = (row: ThreadSummary) => ({ ...row, mailboxIds: row.mailboxIds.toSorted() })

/** `seed` with the message `key` in `mailboxes` instead. */
const filed = (seed: Seed, key: string, mailboxes: string[]): Seed => ({
  ...seed,
  messages: seed.messages.map((message) => (message.key === key ? { ...message, mailboxes } : message)),
})

scenario(
  'a change turned away after one of its steps went through settles failed, and its undo takes that step back',
  async (t) => {
    const { core, box } = await start(t)
    const truth = allTruth(box)
    const lunch = await thread(core, LUNCH)
    // The question leaves Inbox and the answer leaves Sent, or keeps it with labels: two steps.
    box.holdApplies()
    const trash = await accept(t, core, { kind: 'trash', threadIds: [lunch.id] }, 'the trash')
    await box.applyHeld()
    // The first step goes through, and the provider turns the second away.
    box.releaseApplies()
    box.refuseNextApply('conflict')
    t.equal((await core.settled(trash)).result, { failed: 'conflict' }, 'it settles failed')
    const trashed = ['lunch-ask', 'lunch-answer'].filter((key) => truthOf(box, key)?.mailboxes.includes('trash'))
    t.equal(trashed.length, 1, 'the provider holds the step that went through')
    const undo = await accept(t, core, { kind: 'undo', change: trash }, 'the undo')
    t.equal((await core.settled(undo)).result, 'done', 'the undo settles')
    await sync(core)
    t.equal(allTruth(box), truth, 'the provider holds every message as it was')
    t.equal(await thread(core, LUNCH), lunch, 'the row is exactly as it was')
  },
)

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
    const undo = await accept(t, core, { kind: 'undo', change: trash }, 'the undo')
    t.equal((await core.settled(undo)).result, 'done', 'the undo settles')
    await sync(core)
    t.equal(
      [truthOf(box, 'lunch-ask')?.mailboxes, truthOf(box, 'lunch-answer')?.mailboxes],
      [['inbox'], ['sent']],
      'the answer is back where it was, and the question never left, less the deleted mailbox',
    )
  },
  ['labels', 'gmail'],
)

scenario(
  'a gmail step turned away after an earlier request of it went through is undone in full',
  async (t) => {
    const seed = standardSeed(t.dialect)
    const labels = Array.from({ length: 105 }, (_, index) => ({
      key: `label-${index}`,
      name: `Label ${index}`,
      role: null,
    }))
    const many = filed(seed, 'review', ['inbox', ...labels.map((label) => label.key)])
    const { core, box } = await start(t, { ...many, mailboxes: [...seed.mailboxes, ...labels] })
    const truth = allTruth(box)
    const before = await targetRow(core)
    box.holdApplies()
    const trash = await accept(t, core, { kind: 'trash', threadIds: [before.id] }, 'the trash')
    await box.applyHeld()
    // Gmail takes at most 100 labels off in one request, so the one step is two requests. The
    // first goes through, and Gmail turns the second away.
    box.releaseApplies()
    box.refuseNextApply('conflict')
    t.equal((await core.settled(trash)).result, { failed: 'conflict' }, 'it settles failed')
    t.equal(truthOf(box, 'review')?.mailboxes.includes('trash'), true, 'Gmail holds the first request')
    const undo = await accept(t, core, { kind: 'undo', change: trash }, 'the undo')
    t.equal((await core.settled(undo)).result, 'done', 'the undo settles')
    await sync(core)
    t.equal(allTruth(box), truth, 'Gmail holds every message as it was')
    // Gmail lists the labels it put back in its own order.
    t.equal(sorted(await targetRow(core)), sorted(before), 'the row is exactly as it was')
  },
  ['gmail'],
)

scenario('a lost move waits for the whole refresh before it goes again, and so does its undo', async (t) => {
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
  // The provider takes it and the answer is lost. Offline, nothing tries it again yet.
  box.damageNextApplyAnswer('disconnect')
  box.releaseApplies()
  box.setOffline(true)
  t.equal((await core.request({ method: 'sync-now' })).ok, false, 'the provider is offline')
  // The provider forgets every cursor, so the next sync lists the mailbox page by page. With
  // folders the move gave the target a new ref, which only its page tells the core.
  box.expireCursors()
  const undo = await accept(t, core, { kind: 'undo', change: archive }, 'the undo')
  box.setOffline(false)
  await sync(core)
  t.equal(
    [(await core.settled(archive)).result, (await core.settled(undo)).result],
    ['done', 'done'],
    'the archive and its undo both settle as done',
  )
  t.equal(await targetRow(core), before, 'the row is exactly as it was')
  t.equal(allTruth(box), truth, 'the provider holds every message as it was')
})
