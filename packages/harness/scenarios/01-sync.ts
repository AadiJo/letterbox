// Ways the core's copy of a mailbox can come to differ from the provider's.
// Each scenario is one of them.

import {
  fromBen,
  mailbox,
  ME,
  openThread,
  openWithBody,
  readThread,
  signIn,
  standardSeed,
  start,
  sync,
  thread,
  threads,
  truthOf,
  watchThread,
} from '../src/fixtures.ts'
import { scenario } from '../src/scenario.ts'

scenario('first sync shows what the provider holds', async (t) => {
  const { core, box } = await start(t)
  t.equal(
    (await threads(core)).map((item) => item.subject),
    ['Budget numbers', 'December offers', 'Can you review the draft?', 'Lunch on Friday?', 'Trip photos'],
    'five conversations, newest first',
  )
  const inbox = await mailbox(core, 'Inbox')
  t.equal(
    { total: inbox.total, unread: inbox.unread, role: inbox.role },
    { total: 4, unread: 4, role: 'inbox' },
    'inbox counts',
  )
  t.equal((await mailbox(core, 'Sent')).total, 1, 'sent count')
  const accounts = await core.query({ view: 'accounts' })
  t.equal(
    accounts.map((account) => [account.address, account.status.state]),
    [[ME, 'idle']],
    'one account, idle after sync',
  )
  t.equal(
    accounts[0]?.can.multipleMailboxes,
    t.dialect === 'labels',
    'the account says whether a message can sit in several mailboxes',
  )
  t.equal(box.calls().snapshot, 1, 'one snapshot page was enough')
})

scenario('first sync pages through a mailbox larger than one page', async (t) => {
  const { core, box } = await start(t, standardSeed(t.dialect, { pageSize: 2 }))
  t.equal((await threads(core)).length, 5, 'all five conversations arrived')
  t.equal(box.calls().snapshot, 3, 'six messages took three pages')
})

scenario('a message that arrives later shows up after a sync', async (t) => {
  const { core, box } = await start(t)
  const list = core.subscribe({ view: 'threads', filter: {}, offset: 0, limit: 50 })
  await list.next()
  box.deliver(fromBen('standup', 'Standup moved to 10', '2025-12-05T09:00:00.000Z'))
  await sync(core)
  t.equal(list.latest()?.total, 6, 'the list grew by one')
  t.equal(list.latest()?.threads[0]?.subject, 'Standup moved to 10', 'the new conversation is first')
  t.equal(box.calls().snapshot, 1, 'no second snapshot was needed')
})

scenario('a message read on another device becomes read here', async (t) => {
  const { core, box } = await start(t)
  box.setFlags('review', { unread: false })
  await sync(core)
  t.equal((await thread(core, 'Can you review the draft?')).unread, false, 'the conversation is read')
  t.equal((await mailbox(core, 'Inbox')).unread, 3, 'the inbox unread count dropped')
})

scenario('a message moved on another device keeps its identity', async (t) => {
  const { core, box } = await start(t)
  const before = await thread(core, 'Can you review the draft?')
  const correction = await core.command({ kind: 'set-turn', threadIds: [before.id], turn: 'none' })
  await core.settled(correction.change)
  const opened = await openWithBody(core, before.id)
  box.move('review', 'projects')
  await sync(core)
  const after = await thread(core, 'Can you review the draft?')
  const projects = await mailbox(core, 'Projects')
  const reopened = await readThread(core, after.id)
  t.equal(after.id, before.id, 'the conversation kept its id')
  t.equal(reopened?.messages[0]?.id, opened.id, 'the message kept its id')
  t.equal([reopened?.messages[0]?.body.state, box.calls().body], ['ready', 1], 'its body was kept, not fetched again')
  t.equal(after.mailboxIds, [projects.id], 'it is now in Projects only')
  t.equal(after.turn, { holder: 'none', reason: 'set-by-user' }, 'the correction made before the move survived')
  t.equal((await threads(core)).length, 5, 'no duplicate appeared')
})

scenario('a message deleted on another device disappears', async (t) => {
  const { core, box } = await start(t)
  const doomed = await thread(core, 'December offers')
  const open = await openThread(core, doomed.id)
  box.expunge('newsletter')
  await sync(core)
  t.equal((await threads(core)).length, 4, 'four conversations remain')
  t.equal(open.latest(), null, 'the open conversation reports that it is gone')
})

scenario('a message deleted while its body loads ends as gone, then disappears', async (t) => {
  const { core, box } = await start(t)
  const doomed = await thread(core, 'December offers')
  box.holdBodies()
  const open = watchThread(core, doomed.id)
  t.equal((await open.next())?.messages[0]?.body.state, 'loading', 'the body is loading while the provider holds it')
  box.expunge('newsletter')
  box.releaseBodies()
  t.equal(
    (await open.next())?.messages[0]?.body,
    { state: 'unavailable', reason: 'gone' },
    'the late answer says the message is gone',
  )
  await sync(core)
  t.equal(open.latest(), null, 'the next sync removes the conversation')
  t.equal(box.calls().body, 1, 'the body was asked for once')
})

scenario(
  'a message in two mailboxes is one conversation, counted once',
  async (t) => {
    const { core, box } = await start(t)
    box.addToMailbox('review', 'projects')
    await sync(core)
    const both = await thread(core, 'Can you review the draft?')
    const inbox = await mailbox(core, 'Inbox')
    const projects = await mailbox(core, 'Projects')
    t.equal(both.mailboxIds.toSorted(), [inbox.id, projects.id].toSorted(), 'it lists both mailboxes')
    t.equal((await threads(core)).length, 5, 'still five conversations')
    t.equal([inbox.total, projects.total], [4, 1], 'each mailbox counts it once')
  },
  ['labels'],
)

scenario('a mailbox created on another device appears', async (t) => {
  const { core, box } = await start(t)
  box.createMailbox({ key: 'taxes', name: 'Taxes', role: null })
  box.deliver(fromBen('receipt', 'Receipt for the accountant', '2025-12-05T09:00:00.000Z', { mailboxes: ['taxes'] }))
  await sync(core)
  const taxes = await mailbox(core, 'Taxes')
  t.equal(taxes.total, 1, 'the new mailbox holds the new message')
  t.equal((await thread(core, 'Receipt for the accountant')).mailboxIds, [taxes.id], 'the message points at it')
})

scenario('an expired cursor leads to a full resync that converges', async (t) => {
  const { core, box } = await start(t)
  const kept = await thread(core, 'Can you review the draft?')
  const opened = await openWithBody(core, kept.id)
  box.expunge('newsletter')
  box.setFlags('review', { unread: false })
  box.deliver(fromBen('standup', 'Standup moved to 10', '2025-12-05T09:00:00.000Z'))
  box.expireCursors()
  await sync(core)
  t.equal(box.calls().snapshot, 2, 'the core fell back to a second snapshot')
  t.equal(
    (await threads(core)).map((item) => item.subject),
    ['Standup moved to 10', 'Budget numbers', 'Can you review the draft?', 'Lunch on Friday?', 'Trip photos'],
    'the list matches the provider again',
  )
  const after = await thread(core, 'Can you review the draft?')
  t.equal([after.id, after.unread], [kept.id, false], 'a surviving conversation kept its id and took the new state')
  const reopened = await readThread(core, after.id)
  t.equal(
    [reopened?.messages[0]?.id, reopened?.messages[0]?.body.state],
    [opened.id, 'ready'],
    'its message kept its id and its body',
  )
  t.equal(box.calls().body, 1, 'no body was fetched again')
  t.equal(truthOf(box, 'review')?.unread, false, 'the provider agrees')
})

scenario('a restart keeps the mail and resumes with one cheap call', async (t) => {
  const first = await start(t)
  const before = first.box.calls()
  await first.core.stop()
  first.box.deliver(fromBen('standup', 'Standup moved to 10', '2025-12-05T09:00:00.000Z'))

  const core = t.startCore()
  await core.hello()
  t.equal((await threads(core)).length, 5, 'the stored mail is there before any sync')
  await sync(core)
  t.equal((await threads(core)).length, 6, 'the message that arrived while the core was down shows up')
  const after = first.box.calls()
  t.equal(
    [after.snapshot - before.snapshot, after.changes - before.changes],
    [0, 1],
    'no new snapshot, one changes call',
  )
})

scenario('two accounts share one list', async (t) => {
  const { core, accountId } = await start(t)
  const other = standardSeed(t.dialect, { address: 'second@sim.test' })
  t.mailbox(other)
  const secondId = await signIn(t, core, other.address, other.password)
  await sync(core)
  t.equal((await threads(core)).length, 10, 'the unfiltered list holds both accounts')
  t.equal((await threads(core, { accountId: secondId })).length, 5, 'a filter narrows it to one')
  t.check(accountId !== secondId, 'the accounts have different ids')
  const signedOut = await core.request({ method: 'sign-out', accountId: secondId, deleteLocalMail: true })
  t.check(signedOut.ok, 'sign-out is answered')
  t.equal((await threads(core)).length, 5, 'signing out with deletion removes that account’s mail')
  t.equal((await core.query({ view: 'accounts' })).length, 1, 'one account remains')
})
