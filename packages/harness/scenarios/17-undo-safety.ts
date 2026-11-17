// Undo where the core's own records are not the whole story: a call whose answer never came,
// a provider changed by another client, a mailbox deleted there, a merge, a change that alters
// nothing. Held calls, damaged answers and offline turns fix the order of every step.

import type { ChangeId } from '@letterbox/protocol'
import type { Dialect, SimMailbox } from '@letterbox/sim-provider/contract'
import type { CoreClient } from '../src/client.ts'
import { fromBen, mailbox, start, sync, thread, threads, truthOf, untilAccounts } from '../src/fixtures.ts'
import { type Scenario, scenario } from '../src/scenario.ts'
import { accept, allTruth, targetRow } from '../src/undoing.ts'

/** The key of the target message in the standard seed (see TARGET). */
const REVIEW = 'review'

/**
 * Undoes `change`, whose answer never came, as a user would: refused as unknown while offline,
 * then, once a sync shows the provider took all of it and it settles done, reversed.
 */
async function undoAfterSync(t: Scenario, core: CoreClient, box: SimMailbox, change: ChangeId) {
  const early = await core.command({ kind: 'undo', change })
  t.equal(early.kind === 'rejected' && early.conflict, { kind: 'outcome-unknown' }, 'the undo waits for the provider')
  box.setOffline(false)
  await sync(core)
  t.equal((await core.settled(change)).result, 'done', 'the sync shows all of it went through, so it settles done')
  const undo = await accept(t, core, { kind: 'undo', change }, 'the undo after the sync')
  t.equal((await core.settled(undo)).result, 'done', 'the undo settles')
  await sync(core)
}

/** Where an archived message is at the provider: in no mailbox with labels, in Archive with folders. */
const archived = (dialect: Dialect) => (dialect === 'folders' ? ['archive'] : [])

scenario('an archive whose answer was lost can be undone once a sync shows it, and then exactly', async (t) => {
  const { core, box } = await start(t)
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
  // The provider takes it and the connection drops before its answer. Offline, no sync can
  // show what became of it yet.
  box.damageNextApplyAnswer('disconnect')
  box.releaseApplies()
  box.setOffline(true)
  t.equal((await core.request({ method: 'sync-now' })).ok, false, 'the provider is offline')
  t.equal(truthOf(box, REVIEW)?.mailboxes, archived(t.dialect), 'the provider took the archive')
  await undoAfterSync(t, core, box, archive)
  t.equal(await targetRow(core), before, 'the row is exactly as it was')
  t.equal(allTruth(box), truth, 'the provider holds every message as it was')
})

scenario('a restart during an archive’s call leaves its undo to a sync, which then reverses it', async (t) => {
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
  // The provider takes it, and its answer goes nowhere.
  box.releaseApplies()
  box.setOffline(true)

  const core = t.startCore()
  await core.hello()
  t.equal((await core.request({ method: 'sync-now' })).ok, false, 'the provider is offline')
  t.equal(truthOf(box, REVIEW)?.mailboxes, archived(t.dialect), 'the provider took the archive')
  await undoAfterSync(t, core, box, archive)
  t.equal(await targetRow(core), before, 'the row is exactly as it was')
  t.equal(allTruth(box), truth, 'the provider holds every message as it was')
})

scenario('an undo is refused when the provider changed what the change set', async (t) => {
  const { core, box } = await start(t)
  const row = await targetRow(core)
  const trash = await accept(t, core, { kind: 'trash', threadIds: [row.id] }, 'the trash')
  t.equal((await core.settled(trash)).result, 'done', 'the trash settles')
  // A sync first, so the core has seen the message in Trash before it moves again.
  await sync(core)
  // Another client takes it out of Trash and files it in Projects.
  box.move(REVIEW, 'projects')
  await sync(core)
  const moved = truthOf(box, REVIEW)
  const trashBox = await mailbox(core, 'Trash')
  const answer = await core.command({ kind: 'undo', change: trash })
  const conflict = answer.kind === 'rejected' ? answer.conflict : undefined
  const field = conflict?.kind === 'changed' ? conflict.field : undefined
  t.equal(
    [answer.kind === 'rejected' && answer.reason, conflict?.kind, field?.kind === 'mailbox' && field.mailboxId],
    ['conflict', 'changed', trashBox.id],
    'it is refused, naming Trash, which the message is no longer in',
  )
  await sync(core)
  t.equal(truthOf(box, REVIEW), moved, 'it stays in Projects')
})

scenario('a change does only what it recorded, though the change before it is refused', async (t) => {
  const { core, box } = await start(t)
  const truth = allTruth(box)
  const before = await targetRow(core)
  box.holdApplies()
  const first = await accept(t, core, { kind: 'set-flags', threadIds: [before.id], flagged: true }, 'the first flag')
  await box.applyHeld()
  // The row shows it flagged already, so the second flag alters nothing.
  const second = await accept(t, core, { kind: 'set-flags', threadIds: [before.id], flagged: true }, 'the second flag')
  box.refuseNextApply('refused-by-provider')
  box.releaseApplies()
  t.equal(
    [(await core.settled(first)).result, (await core.settled(second)).result],
    [{ failed: 'refused-by-provider' }, 'done'],
    'the first is refused, and the second, which altered nothing, settles',
  )
  const undo = await accept(t, core, { kind: 'undo', change: second }, 'the undo of the second')
  t.equal((await core.settled(undo)).result, 'done', 'its undo settles')
  await sync(core)
  t.equal(box.calls().apply, 1, 'only the first flag reached the provider')
  t.equal(allTruth(box), truth, 'the provider holds every message as it was')
  t.equal(await targetRow(core), before, 'the row is exactly as it was')
})

scenario('a change is undone once, even one that altered nothing', async (t) => {
  const { core } = await start(t)
  const row = await targetRow(core)
  t.equal(row.unread, true, 'it is unread')
  const change = await accept(t, core, { kind: 'set-flags', threadIds: [row.id], unread: true }, 'marking it unread')
  t.equal((await core.settled(change)).result, 'done', 'it settles')
  const undo = await accept(t, core, { kind: 'undo', change }, 'the undo')
  t.equal((await core.settled(undo)).result, 'done', 'the undo settles')
  const again = await core.command({ kind: 'undo', change })
  t.equal(again.kind === 'rejected' && again.reason, 'conflict', 'a second undo, under a new id, is refused')
})

scenario('undoing done is refused once a merge moved the conversation into another', async (t) => {
  const { core, box } = await start(t)
  box.deliver(fromBen('lunch-again', 'Lunch on Friday?', '2025-12-05T09:00:00.000Z'))
  await sync(core)
  const lunches = () => threads(core).then((all) => all.filter((row) => row.subject === 'Lunch on Friday?'))
  const later = (await lunches()).find((row) => row.messageCount === 1)
  if (!later) throw new Error('the second lunch message is not a conversation of its own')
  const done = await accept(t, core, { kind: 'set-turn', threadIds: [later.id], turn: 'none' }, 'marking it done')
  t.equal((await core.settled(done)).result, 'done', 'it settles')
  // A reply to both joins them. The older conversation survives and takes the turn the user set.
  box.deliver(
    fromBen('lunch-both', 'Re: Lunch on Friday?', '2025-12-06T09:00:00.000Z', {
      replyTo: ['lunch-ask', 'lunch-again'],
    }),
  )
  await sync(core)
  t.equal((await lunches()).length, 1, 'they are one conversation now')
  const answer = await core.command({ kind: 'undo', change: done })
  t.equal(
    answer.kind === 'rejected' && [answer.reason, answer.conflict],
    ['conflict', { kind: 'changed', field: { kind: 'turn', threadId: later.id } }],
    'it is refused, naming the conversation that is gone',
  )
})

scenario('an undo that would put a message back in a deleted mailbox is refused', async (t) => {
  const { core, box } = await start(t)
  box.move(REVIEW, 'projects')
  await sync(core)
  const row = await targetRow(core)
  const projects = await mailbox(core, 'Projects')
  // With labels the message leaves Projects. With folders it moves to Archive.
  const change = await accept(
    t,
    core,
    { kind: 'set-mailboxes', threadIds: [row.id], add: [], remove: [projects.id] },
    'taking it out of Projects',
  )
  t.equal((await core.settled(change)).result, 'done', 'it settles')
  box.deleteMailbox('projects')
  await sync(core)
  const answer = await core.command({ kind: 'undo', change })
  t.equal(
    answer.kind === 'rejected' && [answer.reason, answer.conflict],
    ['conflict', { kind: 'mailbox-gone', mailboxId: projects.id }],
    'it is refused, naming the deleted mailbox',
  )
})

scenario('a change whose messages need different steps settles when the messages of one are gone', async (t) => {
  const { core, box } = await start(t)
  const lunch = await thread(core, 'Lunch on Friday?')
  // The question leaves Inbox and the answer leaves Sent, or keeps it with labels: two steps.
  box.setOffline(true)
  const accounts = core.subscribe({ view: 'accounts' })
  const trash = await accept(t, core, { kind: 'trash', threadIds: [lunch.id] }, 'the trash')
  // Its push finds the provider unreachable. Waiting for that keeps the order of the next steps fixed.
  await untilAccounts(accounts, (list) => list[0]?.status.state === 'offline')
  box.expunge('lunch-answer')
  box.setOffline(false)
  await sync(core)
  t.equal((await core.settled(trash)).result, 'done', 'it settles as done')
  t.equal(truthOf(box, 'lunch-ask')?.mailboxes, ['trash'], 'the question is in Trash')
})
