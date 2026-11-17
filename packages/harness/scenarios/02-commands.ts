// Ways a user's action can be lost, doubled, applied out of order, or shown
// wrongly while it is on its way to the provider. Each scenario is one of them.

import type { BlobId, ChangeId, MessageId, ThreadFilter, ThreadSummary } from '@letterbox/protocol'
import {
  ME,
  PASSWORD,
  mailbox,
  signIn,
  standardSeed,
  start,
  sync,
  thread,
  threads,
  truthOf,
  untilAccounts,
} from '../src/fixtures.ts'
import { scenario } from '../src/scenario.ts'

const SUBJECT = 'Can you review the draft?'

scenario('marking read shows at once and reaches the provider', async (t) => {
  const { core, box } = await start(t)
  const target = await thread(core, SUBJECT)
  const list = core.subscribe({ view: 'threads', filter: {}, offset: 0, limit: 50 })
  await list.next()

  const answer = await core.command({ kind: 'set-flags', threadIds: [target.id], unread: false })
  t.equal(answer.kind, 'accepted', 'the command is accepted')
  const settled = await core.settled(answer.change)
  const row = list.latest()?.threads.find((item) => item.id === target.id)
  t.equal(settled.result, 'done', 'the change settles as done')
  t.check(
    answer.kind === 'accepted' && list.rev() >= answer.rev,
    'an update at or past the accepted revision arrived before settled',
  )
  t.equal([row?.unread, row?.pending], [false, false], 'the row is read and no longer pending')
  t.equal(truthOf(box, 'review')?.unread, false, 'the provider holds it as read')
})

scenario('each list filter agrees with the rows, pending changes included', async (t) => {
  const { core, box } = await start(t)
  const mailboxes = await core.query({ view: 'mailboxes' })
  const inbox = await mailbox(core, 'Inbox')
  type Check = [name: string, filter: ThreadFilter, passes: (row: ThreadSummary) => boolean]
  /** Asks for each filter and checks it lists exactly the rows of the whole list that pass it. */
  const agree = async (when: string) => {
    const all = await threads(core)
    const checks: Check[] = [
      ...mailboxes.map((each): Check => [
        `in ${each.name}`,
        { mailboxId: each.id },
        (row) => row.mailboxIds.includes(each.id),
      ]),
      ['unread', { unread: true }, (row) => row.unread],
      ['read', { unread: false }, (row) => !row.unread],
      [
        'unread in the inbox',
        { unread: true, mailboxId: inbox.id },
        (row) => row.unread && row.mailboxIds.includes(inbox.id),
      ],
      ['text "draft"', { text: 'draft' }, (row) => row.subject.toLowerCase().includes('draft')],
    ]
    for (const [name, filter, passes] of checks) {
      const ids = (await threads(core, filter)).map((row) => row.id)
      const expected = all.filter(passes).map((row) => row.id)
      t.equal(ids, expected, `${when}: the ${name} filter lists the rows that pass it`)
    }
  }
  await agree('synced')

  // The archive's call is held at the provider, so both changes stay pending and each filter
  // has to read them. The flip waits behind it, so only its accept has shown it.
  box.holdApplies()
  const target = await thread(core, SUBJECT)
  const archive = await core.command({ kind: 'set-mailboxes', threadIds: [target.id], add: [], remove: [inbox.id] })
  await box.applyHeld()
  const other = (await threads(core)).find((row) => row.id !== target.id)
  t.check(other !== undefined, 'there is a second conversation')
  if (!other) return
  const flip = await core.command({ kind: 'set-flags', threadIds: [other.id], unread: !other.unread })
  t.check((await thread(core, SUBJECT)).pending, 'the archive is still pending')
  const flipped = (await threads(core)).find((row) => row.id === other.id)
  t.equal([flipped?.unread, flipped?.pending], [!other.unread, true], 'the flip shows at once, pending')
  await agree('with pending changes')

  box.releaseApplies()
  await sync(core)
  t.equal(
    [(await core.settled(archive.change)).result, (await core.settled(flip.change)).result],
    ['done', 'done'],
    'both changes settle',
  )
  await agree('settled')
})

scenario('archiving takes a conversation out of the inbox', async (t) => {
  const { core, box } = await start(t)
  const target = await thread(core, SUBJECT)
  const inbox = await mailbox(core, 'Inbox')
  const answer = await core.command({ kind: 'set-mailboxes', threadIds: [target.id], add: [], remove: [inbox.id] })
  t.equal((await core.settled(answer.change)).result, 'done', 'the change settles as done')
  t.equal(
    truthOf(box, 'review')?.mailboxes,
    t.dialect === 'labels' ? [] : ['archive'],
    'the provider archived it the way it archives',
  )
  await sync(core)
  const after = await thread(core, SUBJECT)
  t.equal(after.id, target.id, 'the conversation kept its id after the provider echoed the change')
  t.check(!after.mailboxIds.includes(inbox.id), 'it is out of the inbox')
  t.equal((await threads(core)).length, 5, 'the echo made no duplicate')
  t.equal((await mailbox(core, 'Inbox')).total, 3, 'the inbox count dropped')
})

scenario('moving to a mailbox and trashing both reach the provider', async (t) => {
  const { core, box } = await start(t)
  const inbox = await mailbox(core, 'Inbox')
  const projects = await mailbox(core, 'Projects')
  const moved = await thread(core, SUBJECT)
  const move = await core.command({
    kind: 'set-mailboxes',
    threadIds: [moved.id],
    add: [projects.id],
    remove: [inbox.id],
  })
  t.equal((await core.settled(move.change)).result, 'done', 'the move settles as done')
  t.equal(truthOf(box, 'review')?.mailboxes, ['projects'], 'the provider moved it')

  const binned = await thread(core, 'December offers')
  const trash = await core.command({ kind: 'trash', threadIds: [binned.id] })
  t.equal((await core.settled(trash.change)).result, 'done', 'the trash settles as done')
  t.equal(truthOf(box, 'newsletter')?.mailboxes, ['trash'], 'the provider put it in the trash')
  t.equal(
    (await thread(core, 'December offers')).mailboxIds,
    [(await mailbox(core, 'Trash')).id],
    'the core shows it in Trash',
  )
})

scenario('a second change follows a message the first one moved', async (t) => {
  const { core, box } = await start(t)
  const target = await thread(core, SUBJECT)
  const inbox = await mailbox(core, 'Inbox')
  const archive = await core.command({ kind: 'set-mailboxes', threadIds: [target.id], add: [], remove: [inbox.id] })
  const read = await core.command({ kind: 'set-flags', threadIds: [target.id], unread: false })
  t.equal(
    [(await core.settled(archive.change)).result, (await core.settled(read.change)).result],
    ['done', 'done'],
    'both settle as done with no sync in between',
  )
  const truth = truthOf(box, 'review')
  t.equal(
    [truth?.unread, truth?.mailboxes.includes('inbox')],
    [false, false],
    'the provider holds it archived and read',
  )
})

scenario('changes made offline replay in order when the provider is back', async (t) => {
  const { core, box } = await start(t)
  const target = await thread(core, SUBJECT)
  box.setOffline(true)
  const accounts = core.subscribe({ view: 'accounts' })
  const first = await core.command({ kind: 'set-flags', threadIds: [target.id], unread: false })
  // Its push finds the provider unreachable. Waiting for that keeps the order of the next steps fixed.
  await untilAccounts(accounts, (list) => list[0]?.status.state === 'offline')
  const second = await core.command({ kind: 'set-flags', threadIds: [target.id], unread: true, flagged: true })
  t.equal([first.kind, second.kind], ['accepted', 'accepted'], 'both are accepted while offline')
  const waiting = await thread(core, SUBJECT)
  t.equal(
    [waiting.unread, waiting.flagged, waiting.pending],
    [true, true, true],
    'the row shows the last action and is pending',
  )
  t.equal(
    truthOf(box, 'review'),
    { key: 'review', mailboxes: ['inbox'], unread: true, flagged: false },
    'the provider has seen nothing yet',
  )
  t.equal((await core.request({ method: 'sync-now' })).ok, false, 'a sync while offline says so')

  box.setOffline(false)
  await sync(core)
  // The second is awaited first. A wait that took any change's settled would get the first's, at the lower revision.
  const settledSecond = await core.settled(second.change)
  const settledFirst = await core.settled(first.change)
  t.equal([settledFirst.result, settledSecond.result], ['done', 'done'], 'both settle as done')
  t.check(settledFirst.rev <= settledSecond.rev, 'they settle in the order they were made')
  t.equal(
    truthOf(box, 'review'),
    { key: 'review', mailboxes: ['inbox'], unread: true, flagged: true },
    'the provider ends on the last action',
  )
  t.equal(box.calls().apply, 2, 'each change was pushed once')
})

scenario('a change the provider refuses is undone before the core says so', async (t) => {
  const { core, box } = await start(t)
  const target = await thread(core, SUBJECT)
  const list = core.subscribe({ view: 'threads', filter: {}, offset: 0, limit: 50 })
  await list.next()
  box.refuseNextApply('conflict')
  const answer = await core.command({ kind: 'set-flags', threadIds: [target.id], unread: false })
  const settled = await core.settled(answer.change)
  const row = list.latest()?.threads.find((item) => item.id === target.id)
  t.equal(settled.result, { failed: 'conflict' }, 'the change settles as failed')
  t.equal([row?.unread, row?.pending], [true, false], 'the row is unread again and not pending')
  t.check(list.rev() >= settled.rev, 'the revert was sent before settled')
})

scenario('a change to a message that vanished settles as failed', async (t) => {
  const { core, box } = await start(t)
  const target = await thread(core, SUBJECT)
  box.setOffline(true)
  const answer = await core.command({ kind: 'set-flags', threadIds: [target.id], unread: false })
  box.expunge('review')
  box.setOffline(false)
  await sync(core)
  t.equal((await core.settled(answer.change)).result, { failed: 'unknown-target' }, 'the change settles as failed')
  t.equal((await threads(core)).length, 4, 'the conversation is gone here too')
})

scenario('sending the same change twice has one effect', async (t) => {
  const { core, box } = await start(t)
  const target = await thread(core, SUBJECT)
  const change = 'change_twice' as ChangeId
  const first = await core.command({ kind: 'set-flags', threadIds: [target.id], unread: false }, change)
  await core.settled(change)
  const again = await core.command({ kind: 'set-flags', threadIds: [target.id], unread: false }, change)
  const settledAgain = await core.settled(change)
  t.equal([first.kind, again.kind], ['accepted', 'accepted'], 'both sends are answered as accepted')
  t.check(
    first.kind === 'accepted' && again.kind === 'accepted' && first.rev === again.rev,
    'the second answer repeats the first revision',
  )
  t.equal(settledAgain.result, 'done', 'the second send is told the outcome again')
  t.equal(box.calls().apply, 1, 'the provider was asked once')
})

scenario('a read-only account refuses changes but still takes turn corrections', async (t) => {
  const { core, box, accountId } = await start(t, standardSeed(t.dialect, { canModify: false }))
  const target = await thread(core, SUBJECT)
  t.equal((await core.query({ view: 'accounts' }))[0]?.can.modify, false, 'the account says it cannot modify')
  const refused = await core.command({ kind: 'set-flags', threadIds: [target.id], unread: false })
  t.equal(
    [refused.kind, refused.kind === 'rejected' && refused.reason],
    ['rejected', 'not-permitted'],
    'marking read is rejected',
  )
  const send = await core.command({
    kind: 'send',
    draft: {
      accountId,
      to: ['ben@example.com'],
      cc: [],
      bcc: [],
      subject: 'Re: Can you review the draft?',
      text: 'Yes.',
      html: null,
      inReplyTo: null,
    },
  })
  t.equal(send.kind === 'rejected' && send.reason, 'not-permitted', 'sending is rejected')
  const correction = await core.command({ kind: 'set-turn', threadIds: [target.id], turn: 'theirs' })
  t.equal((await core.settled(correction.change)).result, 'done', 'a turn correction settles as done')
  t.equal(box.calls().apply, 0, 'the provider was never asked to change anything')
})

scenario(
  'a folders account cannot put a message in a second mailbox',
  async (t) => {
    const { core } = await start(t)
    const target = await thread(core, SUBJECT)
    const projects = await mailbox(core, 'Projects')
    const answer = await core.command({ kind: 'set-mailboxes', threadIds: [target.id], add: [projects.id], remove: [] })
    t.equal(
      [answer.kind, answer.kind === 'rejected' && answer.reason],
      ['rejected', 'not-supported'],
      'the command is rejected',
    )
    t.equal((await thread(core, SUBJECT)).mailboxIds, target.mailboxIds, 'nothing changed')
  },
  ['folders'],
)

scenario('commands with nothing to act on, that cannot be written, or not built yet, are rejected', async (t) => {
  const { core, accountId } = await start(t)
  const missing = await core.command({ kind: 'set-flags', threadIds: [], unread: false })
  t.equal(
    missing.kind === 'rejected' && missing.reason,
    'unknown-target',
    'a command naming no known conversation is rejected',
  )
  const draft = { accountId, to: ['ana@example.com'], cc: [], bcc: [], subject: 'Hi', text: 'Hi', html: null }
  const nobody = await core.command({ kind: 'send', draft: { ...draft, to: [], inReplyTo: null } })
  t.equal(nobody.kind === 'rejected' && nobody.reason, 'invalid', 'a send to nobody is rejected')
  const injected = await core.command({
    kind: 'send',
    draft: { ...draft, to: ['ana@example.com\r\nBcc: eve@example.com'], inReplyTo: null },
  })
  t.equal(injected.kind === 'rejected' && injected.reason, 'invalid', 'an address that would add a header is rejected')
  const orphan = await core.command({ kind: 'send', draft: { ...draft, inReplyTo: 'message_none' as MessageId } })
  t.equal(orphan.kind === 'rejected' && orphan.reason, 'unknown-target', 'a reply to no known message is rejected')
  const undo = await core.command({ kind: 'undo', change: 'change_none' as ChangeId })
  t.equal(undo.kind === 'rejected' && undo.reason, 'unknown-target', 'an undo naming no change is rejected')
  const flag = await core.command({ kind: 'set-flags', threadIds: [(await thread(core, SUBJECT)).id], flagged: true })
  await core.settled(flag.change)
  const unflag = await core.command({ kind: 'undo', change: flag.change })
  await core.settled(unflag.change)
  const redo = await core.command({ kind: 'undo', change: unflag.change })
  t.equal(redo.kind === 'rejected' && redo.reason, 'not-supported', 'an undo cannot itself be undone')
  const blob = await core.request({ method: 'blob', blobId: 'blob_message_1_1' as BlobId })
  t.equal(blob.ok === false && blob.error, 'not-supported', 'attachment bytes are not built yet and say so')
})

scenario('a command after a restart is not mistaken for one made before it', async (t) => {
  const first = await start(t)
  const target = await thread(first.core, SUBJECT)
  const before = await first.core.command({ kind: 'set-flags', threadIds: [target.id], unread: false })
  t.equal((await first.core.settled(before.change)).result, 'done', 'the first change settles')
  await first.core.stop()

  // The second core takes the same steps as the first, so ids that restart with each core would repeat.
  const core = t.startCore()
  await core.hello()
  await signIn(t, core, ME, PASSWORD)
  await sync(core)
  const again = await core.command({
    kind: 'set-flags',
    threadIds: [(await thread(core, SUBJECT)).id],
    flagged: true,
  })
  t.check(again.change !== before.change, 'the new command has a change id of its own')
  t.equal((await core.settled(again.change)).result, 'done', 'it settles')
  t.equal(truthOf(first.box, 'review')?.flagged, true, 'the provider holds the new change')
})

scenario('a pending change survives a restart', async (t) => {
  const first = await start(t)
  const target = await thread(first.core, SUBJECT)
  first.box.setOffline(true)
  const answer = await first.core.command({ kind: 'set-flags', threadIds: [target.id], unread: false })
  await first.core.stop()
  first.box.setOffline(false)

  const core = t.startCore()
  await core.hello()
  t.equal((await thread(core, SUBJECT)).pending, true, 'the change is still pending after the restart')
  await sync(core)
  t.equal((await core.settled(answer.change)).result, 'done', 'it settles once the provider is reachable')
  t.equal(truthOf(first.box, 'review')?.unread, false, 'the provider holds it as read')
})
