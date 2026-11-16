// Undo: every kind of change can be taken back, exactly. A change the provider has none of
// is cancelled and never goes out. One it holds is reversed: each message gets back what the
// change altered, and nothing else. Each scenario is one way an undo could miss, overreach,
// clobber a later change, or happen twice.

import type { ChangeId, Command } from '@letterbox/protocol'
import { mailbox, start, sync, thread, truthOf } from '../src/fixtures.ts'
import { scenario } from '../src/scenario.ts'
import { accept, allTruth, KINDS, lunchSeed, TARGET, targetRow } from '../src/undoing.ts'

scenario('undo before sync cancels each kind of change, and the provider never sees it', async (t) => {
  const { core, box } = await start(t)
  const truth = allTruth(box)
  box.setOffline(true)
  for (const kind of KINDS) {
    const before = await targetRow(core)
    const change = await accept(t, core, await kind.command(core, t, before), kind.name)
    // A sync answers once the pass the change queued has ended, so no call for it is in flight.
    t.equal((await core.request({ method: 'sync-now' })).ok, false, `${kind.name}: the provider is offline`)
    t.equal((await targetRow(core)).pending, !kind.local, `${kind.name}: it shows at once`)
    const undo = await accept(t, core, { kind: 'undo', change }, `${kind.name}: the undo`)
    const settled = [(await core.settled(change)).result, (await core.settled(undo)).result]
    t.equal(settled, kind.local ? ['done', 'done'] : ['undone', 'done'], `${kind.name}: both settle`)
    t.equal(await targetRow(core), before, `${kind.name}: the row is exactly as it was`)
  }
  box.setOffline(false)
  await sync(core)
  t.equal(box.calls().apply, 0, 'the provider was never asked to change anything')
  t.equal(allTruth(box), truth, 'the provider holds every message as it was')
})

scenario('undo after sync reverses each kind of change exactly', async (t) => {
  const { core, box } = await start(t)
  const truth = allTruth(box)
  for (const kind of KINDS) {
    const before = await targetRow(core)
    const applied = box.calls().apply
    const change = await accept(t, core, await kind.command(core, t, before), kind.name)
    t.equal((await core.settled(change)).result, 'done', `${kind.name}: it settles`)
    await sync(core)
    const undo = await accept(t, core, { kind: 'undo', change }, `${kind.name}: the undo`)
    t.equal((await core.settled(undo)).result, 'done', `${kind.name}: the undo settles`)
    await sync(core)
    t.equal(await targetRow(core), before, `${kind.name}: the row is exactly as it was`)
    t.equal(allTruth(box), truth, `${kind.name}: the provider holds every message as it was`)
    t.equal(
      box.calls().apply - applied,
      kind.local ? 0 : 2,
      `${kind.name}: the change and its undo each reached the provider once`,
    )
  }
})

scenario('undoing an archive or a trash leaves sent and already archived mail where it was', async (t) => {
  const { core, box } = await start(t, lunchSeed(t.dialect))
  const truth = allTruth(box)
  const inbox = await mailbox(core, 'Inbox')
  const lunch = await thread(core, 'Lunch on Friday?')
  t.equal(lunch.messageCount, 3, 'the conversation holds an inbox, a sent and an archived message')
  const commands: Command[] = [
    { kind: 'set-mailboxes', threadIds: [lunch.id], add: [], remove: [inbox.id] },
    { kind: 'trash', threadIds: [lunch.id] },
  ]
  for (const command of commands) {
    const change = await accept(t, core, command, command.kind)
    t.equal((await core.settled(change)).result, 'done', `${command.kind}: it settles`)
    await sync(core)
    const undo = await accept(t, core, { kind: 'undo', change }, `${command.kind}: the undo`)
    t.equal((await core.settled(undo)).result, 'done', `${command.kind}: the undo settles`)
    await sync(core)
    t.equal(
      allTruth(box),
      truth,
      `${command.kind}: every message is exactly where it was, the sent and archived ones too`,
    )
    t.equal(await thread(core, 'Lunch on Friday?'), lunch, `${command.kind}: the row is exactly as it was`)
  }
})

scenario('undoing done gives back the turn the user set, not the one the rule gives', async (t) => {
  const { core } = await start(t)
  const lunch = await thread(core, 'Lunch on Friday?')
  t.equal(lunch.turn, { holder: 'theirs', reason: 'i-wrote-last' }, 'the rule says it is their turn')
  const mine = await accept(t, core, { kind: 'set-turn', threadIds: [lunch.id], turn: 'mine' }, 'taking the turn')
  await core.settled(mine)
  const before = await thread(core, 'Lunch on Friday?')
  const done = await accept(t, core, { kind: 'set-turn', threadIds: [lunch.id], turn: 'none' }, 'marking done')
  await core.settled(done)
  const undo = await accept(t, core, { kind: 'undo', change: done }, 'the undo')
  t.equal((await core.settled(undo)).result, 'done', 'the undo settles at once')
  t.equal((await thread(core, 'Lunch on Friday?')).turn, before.turn, 'the turn is mine again, as the user set it')
})

scenario('an undo is refused when a later change altered the same field', async (t) => {
  const { core, box } = await start(t)
  const row = await targetRow(core)
  const read = await accept(t, core, { kind: 'set-flags', threadIds: [row.id], unread: false }, 'marking read')
  const flag = await accept(t, core, { kind: 'set-flags', threadIds: [row.id], flagged: true }, 'flagging')
  const unread = await accept(t, core, { kind: 'set-flags', threadIds: [row.id], unread: true }, 'marking unread')
  for (const change of [read, flag, unread]) await core.settled(change)
  const refused = await core.command({ kind: 'undo', change: read })
  t.equal(
    refused.kind === 'rejected' && refused.reason,
    'conflict',
    'undoing the read is refused: a later change set it unread',
  )
  const unflag = await accept(t, core, { kind: 'undo', change: flag }, 'undoing the flag, which nothing changed since')
  t.equal((await core.settled(unflag)).result, 'done', 'the flag undo settles')
  const after = await targetRow(core)
  t.equal([after.unread, after.flagged], [true, false], 'unread as the later change left it, and no longer flagged')
  t.equal(
    truthOf(box, 'review'),
    { key: 'review', mailboxes: ['inbox'], unread: true, flagged: false },
    'the provider agrees',
  )
})

scenario('an undo is answered the same when sent twice, and a change is undone once', async (t) => {
  const { core, box } = await start(t)
  const row = await targetRow(core)
  const flag = await accept(t, core, { kind: 'set-flags', threadIds: [row.id], flagged: true }, 'flagging')
  await core.settled(flag)
  const twice = 'change_undo_twice' as ChangeId
  const first = await core.command({ kind: 'undo', change: flag }, twice)
  await core.settled(twice)
  const again = await core.command({ kind: 'undo', change: flag }, twice)
  t.check(
    first.kind === 'accepted' && again.kind === 'accepted' && first.rev === again.rev,
    'the same undo sent again is answered with the first revision',
  )
  t.equal(box.calls().apply, 2, 'the provider got the flag and one undo')
  const second = await core.command({ kind: 'undo', change: flag })
  t.equal(
    second.kind === 'rejected' && second.reason,
    'conflict',
    'a second undo of the flag is refused: it is undone already',
  )
  const redo = await core.command({ kind: 'undo', change: twice })
  t.equal(redo.kind === 'rejected' && redo.reason, 'not-supported', 'an undo cannot be undone')
  t.equal((await thread(core, TARGET)).flagged, false, 'the conversation is not flagged')
})

scenario('an undo of a change the provider refused is refused as a conflict', async (t) => {
  const { core, box } = await start(t)
  const row = await targetRow(core)
  box.refuseNextApply('conflict')
  const flag = await accept(t, core, { kind: 'set-flags', threadIds: [row.id], flagged: true }, 'flagging')
  t.equal((await core.settled(flag)).result, { failed: 'conflict' }, 'the provider refuses it')
  const undo = await core.command({ kind: 'undo', change: flag })
  t.equal(undo.kind === 'rejected' && undo.reason, 'conflict', 'the undo is refused: the change is rolled back already')
  t.equal(await targetRow(core), row, 'the row is as it was')
})
