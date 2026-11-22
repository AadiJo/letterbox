// The core pulls on its own while it runs (crates/core/src/schedule.rs): at start, then every
// minute, sooner once the provider can be reached again, and later while pulls fail. Ways it
// can go wrong: mail that never comes in without a sync-now, a reply never told, a pull piled
// on one already queued or running, an offline provider asked every minute, a recovery that
// waits out the backoff, or a close held up by a wait for the next pull.
//
// The fixed clock holds every idle wait until the scenario moves it (`advanceClock`), and
// `idleWaits` says when the schedule began its next wait, which it does once its pull has
// ended. None of these scenarios asks for a sync after the sign-in's.

import type { Subscription } from '../src/client.ts'
import type { Scenario } from '../src/scenario.ts'
import { fromBen, ME, start, thread, untilAccounts } from '../src/fixtures.ts'
import { scenario } from '../src/scenario.ts'

const ANA = { name: 'Ana', address: 'ana@example.com' }

/** Waits until the open list `view` holds a conversation with `subject`, and says so. */
async function untilListed(t: Scenario, view: Subscription<'threads'>, subject: string, what: string) {
  for (;;) {
    const listed = view.latest()?.threads.some((row) => row.subject === subject) ?? false
    if (listed) return t.check(true, what)
    await view.next()
  }
}

const inboxList = { view: 'threads', filter: {}, offset: 0, limit: 500 } as const

scenario('a core that starts with a signed-in account pulls the mail that came while it was down', async (t) => {
  const { core: first, box } = await start(t)
  await first.stop()
  box.deliver(fromBen('away', 'While you were away', '2025-12-05T09:00:00.000Z'))
  const core = t.startCore()
  await core.hello()
  const list = core.subscribe(inboxList)
  await list.next()
  t.equal(await core.idleWaits(1), [0], 'its first pull is due at once')
  core.advanceClock(0)
  await untilListed(t, list, 'While you were away', 'the mail that came while it was down is listed')
  t.equal(await core.idleWaits(2), [0, 60], 'the next pull is a minute after it')
})

scenario('mail that comes while the core runs is listed once the clock passes a minute', async (t) => {
  const { core, box } = await start(t)
  t.equal(await core.idleWaits(1), [60], "the next pull is a minute after the sign-in's")
  const list = core.subscribe(inboxList)
  await list.next()
  box.deliver(fromBen('fresh', 'Fresh news', '2025-12-09T09:00:00.000Z'))
  core.advanceClock(60)
  await untilListed(t, list, 'Fresh news', 'the new mail is listed')
  t.equal(await core.idleWaits(2), [60, 60], 'and the pull after it is a minute later')
  box.deliver(fromBen('fresher', 'Fresher news', '2025-12-09T10:00:00.000Z'))
  core.advanceClock(60)
  await untilListed(t, list, 'Fresher news', 'so is the mail after that')
})

scenario('the schedule starts no pull while another one is running or queued', async (t) => {
  const { core, box } = await start(t)
  await core.idleWaits(1)
  // A sync-now whose pull is running: its snapshot page is held.
  box.expireCursors()
  box.holdSnapshots()
  const running = core.begin({ method: 'sync-now' })
  await box.snapshotHeld()
  core.advanceClock(60)
  t.equal(await core.idleWaits(2), [60, 60], 'with a pull running, it waits a minute more instead of queuing one')
  box.releaseSnapshots()
  t.check((await running.done).ok, 'the running sync ends well')

  // A sync-now queued behind a change whose push is held.
  const target = await thread(core, 'Can you review the draft?')
  box.holdApplies()
  const change = await core.command({ kind: 'set-flags', threadIds: [target.id], unread: false })
  await box.applyHeld()
  const queued = core.begin({ method: 'sync-now' })
  // Answered after the sync-now before it was read, so that sync-now is queued by then.
  await core.query({ view: 'accounts' })
  core.advanceClock(60)
  t.equal(await core.idleWaits(3), [60, 60, 60], 'with a pull queued, it waits a minute more instead of queuing one')
  const changes = box.calls().changes
  box.releaseApplies()
  await core.settled(change.change)
  t.check((await queued.done).ok, 'the queued sync ends well')
  t.equal(box.calls().changes, changes + 1, 'only the queued sync pulled')
})

scenario('the schedule backs off while offline, and pulls at once when the provider is back', async (t) => {
  const { core, box } = await start(t)
  await core.idleWaits(1)
  const offline = core.subscribe({ view: 'accounts' })
  box.setOffline(true)
  core.advanceClock(60)
  await untilAccounts(offline, (list) => list[0]?.status.state === 'offline')
  t.equal(await core.idleWaits(2), [60, 120], 'a pull that finds the provider offline doubles the wait')
  core.advanceClock(120)
  t.equal(await core.idleWaits(3), [60, 120, 240], 'and so does the next one')
  box.deliver(fromBen('meanwhile', 'Sent while you were offline', '2025-12-09T09:00:00.000Z'))
  box.setOffline(false)

  // A change reaches the provider, so it can be reached again: the schedule pulls now.
  const list = core.subscribe(inboxList)
  await list.next()
  const back = core.subscribe({ view: 'accounts' })
  const target = await thread(core, 'Can you review the draft?')
  const change = await core.command({ kind: 'set-flags', threadIds: [target.id], unread: false })
  t.equal((await core.settled(change.change)).result, 'done', 'the change reaches the provider')
  await untilAccounts(back, (accounts) => accounts[0]?.status.state !== 'offline')
  t.equal(await core.idleWaits(4), [60, 120, 240, 0], 'the next pull is due at once, not after the backoff')
  core.advanceClock(0)
  await untilListed(t, list, 'Sent while you were offline', 'the mail sent while it was offline is listed')
  t.equal(await core.idleWaits(5), [60, 120, 240, 0, 60], 'and the pulls after it are a minute apart again')
})

scenario('a core closed while it waits for its next pull exits at once', async (t) => {
  const { core } = await start(t)
  await core.idleWaits(1)
  // stop() fails unless the core exits within the usual wait, and the next pull is a minute away.
  await core.stop()
  t.check(true, 'the core exited without waiting for its next pull')
})

scenario('a reply from a person while the core runs is told once, with no sync-now', async (t) => {
  const { core, box } = await start(t)
  await core.idleWaits(1)
  box.deliver({
    key: 'lunch-reply',
    mailboxes: ['inbox'],
    from: ANA,
    to: [ME],
    subject: 'Re: Lunch on Friday?',
    text: 'Great, see you at noon.',
    sentAt: '2025-12-05T09:00:00.000Z',
    replyTo: ['lunch-ask', 'lunch-answer'],
  })
  core.advanceClock(60)
  const told = await core.take('your-turn')
  t.equal(told.threadId, (await thread(core, 'Lunch on Friday?')).id, 'the reply is told with its conversation')
  await core.idleWaits(2)
  // The next one told is the sentinel's, so the reply was told once.
  box.deliver(fromBen('sentinel', 'Are you around?', '2025-12-09T09:00:00.000Z'))
  core.advanceClock(60)
  const next = await core.take('your-turn')
  t.equal(next.threadId, (await thread(core, 'Are you around?')).id, 'the next conversation told is the next reply')
})
