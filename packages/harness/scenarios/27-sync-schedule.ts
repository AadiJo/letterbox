// The core pulls on its own while it runs (crates/core/src/schedule.rs): at start, then every
// minute, sooner once the provider can be reached again, and later while pulls fail. Ways it
// can go wrong: mail that never comes in without a sync-now, a reply never told, a pull piled
// on one already queued or running (a sync-now's, a backfill page's, or a push's pull to
// settle a change whose answer was lost), a first wait timed from before a slow first sync, an
// offline provider asked every minute, a recovery that waits out the backoff, a UI told it is
// syncing every minute, and a close held up by a wait for the next pull. A Gmail call whose
// answer stalls is in 28-gmail-deadlines.ts.
//
// The fixed clock holds every idle wait until the scenario moves it (`advanceClock`), and
// `idleWaits` says when the schedule began its next wait, which it does once its pull has
// ended. None of these scenarios asks for a sync after the sign-in's.

import type { Subscription } from '../src/client.ts'
import type { Scenario } from '../src/scenario.ts'
import { fromBen, ME, PASSWORD, signIn, standardSeed, start, sync, thread, untilAccounts } from '../src/fixtures.ts'
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
  // Ben is a person, so his mail is told. Taken here, so it lands in the same place every run.
  await core.take('your-turn')
  t.equal(await core.idleWaits(2), [60, 60], 'and the pull after it is a minute later')
  box.deliver(fromBen('fresher', 'Fresher news', '2025-12-09T10:00:00.000Z'))
  core.advanceClock(60)
  await untilListed(t, list, 'Fresher news', 'so is the mail after that')
  await core.take('your-turn')
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
  // Ben is a person, so his mail is told. Taken here, so it lands in the same place every run.
  await core.take('your-turn')
  t.equal(await core.idleWaits(5), [60, 120, 240, 0, 60], 'and the pulls after it are a minute apart again')
})

scenario(
  'health a queued push clears before the schedule resumes from a failed pull still brings the next pull at once',
  async (t) => {
    const { core, box } = await start(t)
    await core.idleWaits(1)
    // The scheduled pull lists a snapshot, held.
    box.expireCursors()
    box.holdSnapshots()
    core.advanceClock(60)
    await box.snapshotHeld()
    // A change queues a push behind it, and its undo cancels the change before any call, so
    // that push carries nothing: it ends at once, and reads the account as healthy.
    const target = await thread(core, 'Can you review the draft?')
    const change = await core.command({ kind: 'set-flags', threadIds: [target.id], unread: false })
    const undo = await core.command({ kind: 'undo', change: change.change })
    t.equal((await core.settled(change.change)).result, 'undone', 'the change never goes out')
    await core.settled(undo.change)
    // The pull fails offline. The push runs right after, before the schedule resumes, and clears the health.
    box.setOffline(true)
    box.releaseSnapshots()
    t.equal(await core.idleWaits(2), [60, 0], 'the health reads clear, so the next pull is due at once')
  },
  ['labels', 'folders'],
)

scenario('a core closed while it waits for its next pull exits at once', async (t) => {
  const { core } = await start(t)
  await core.idleWaits(1)
  // stop() fails unless the core exits within the usual wait, and the next pull is a minute away.
  await core.stop()
  t.equal(core.exitCode(), 0, 'the core exited cleanly without waiting for its next pull')
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

scenario('the schedule starts no pull while a backfill page or a push that pulls first is running', async (t) => {
  const { core, box } = await start(t, standardSeed(t.dialect, { pageSize: 2 }))
  await core.idleWaits(1)
  // A backfill: page 1 goes in the sync-now's pass, and page 2 is its own job, held.
  box.expireCursors()
  box.holdSnapshots()
  const syncing = core.begin({ method: 'sync-now' })
  await box.snapshotHeld()
  box.releaseSnapshots()
  box.holdSnapshots()
  await box.snapshotHeld()
  core.advanceClock(60)
  t.equal(await core.idleWaits(2), [60, 60], 'with a backfill page running, it waits a minute more')
  box.releaseSnapshots()
  t.check((await syncing.done).ok, 'the backfill ends well')

  // A change whose answer is lost leaves the core unsure what the provider holds, so the next
  // push pulls first. Its pull lists a snapshot, held.
  const target = await thread(core, 'Can you review the draft?')
  const accounts = core.subscribe({ view: 'accounts' })
  box.damageNextApplyAnswer('disconnect')
  const lost = await core.command({ kind: 'set-flags', threadIds: [target.id], unread: false })
  // Its push ends with the answer lost, which reads as offline. Waiting for that fixes the order.
  await untilAccounts(accounts, (list) => list[0]?.status.state === 'offline')
  box.expireCursors()
  box.holdSnapshots()
  const other = await thread(core, 'Lunch on Friday?')
  const next = await core.command({ kind: 'set-flags', threadIds: [other.id], flagged: true })
  await box.snapshotHeld()
  core.advanceClock(60)
  t.equal(await core.idleWaits(3), [60, 60, 60], "with a push's pull running, it waits a minute more")
  box.releaseSnapshots()
  // How each settles is the push's business (see 18-undo-partial.ts). Here they only must.
  await core.settled(lost.change)
  await core.settled(next.change)
  t.check(true, 'both changes settle once the pull ends')
})

scenario('a scheduled pull skips when a push queued ahead of it pulled to settle a lost change', async (t) => {
  const { core, box } = await start(t)
  await core.idleWaits(1)
  const target = await thread(core, 'Can you review the draft?')
  const other = await thread(core, 'Lunch on Friday?')
  // A change whose push is held, and whose answer will be lost.
  box.damageNextApplyAnswer('disconnect')
  box.holdApplies()
  const lost = await core.command({ kind: 'set-flags', threadIds: [target.id], unread: false })
  await box.applyHeld()
  // A second change queues a push, and its undo leaves that push nothing to carry. It pulls
  // first all the same once the first change's answer is lost, as the core is then unsure.
  const next = await core.command({ kind: 'set-flags', threadIds: [other.id], flagged: true })
  const undo = await core.command({ kind: 'undo', change: next.change })
  // Settled at once, as the change it undoes never went out. Awaited, so it lands in the same place every run.
  await core.settled(undo.change)
  // The tick finds no pull queued or running, so it queues one behind that push.
  core.advanceClock(60)
  await core.pullsQueued(1)
  const pulls = box.calls().changes
  box.releaseApplies()
  await core.settled(lost.change)
  t.equal(await core.idleWaits(2), [60, 60], 'the schedule waits a minute more')
  t.equal(box.calls().changes, pulls + 1, "only the push's pull reached the provider")
})

scenario("a push's pull that leaves a backfill stands for the scheduled pull, and its failure backs off", async (t) => {
  const { core, box } = await start(t, standardSeed(t.dialect, { pageSize: 2 }))
  await core.idleWaits(1)
  const target = await thread(core, 'Can you review the draft?')
  const other = await thread(core, 'Lunch on Friday?')
  // As in the scenario above, a push queued behind a held one will pull to settle its lost answer.
  box.damageNextApplyAnswer('disconnect')
  box.holdApplies()
  const lost = await core.command({ kind: 'set-flags', threadIds: [target.id], unread: false })
  await box.applyHeld()
  const next = await core.command({ kind: 'set-flags', threadIds: [other.id], flagged: true })
  const undo = await core.command({ kind: 'undo', change: next.change })
  // Settled at once, as the change it undoes never went out. Awaited, so it lands in the same place every run.
  await core.settled(undo.change)
  // Its pull lists the mailbox again, page by page, so its next page queues behind the tick's job.
  box.expireCursors()
  box.holdSnapshots()
  core.advanceClock(60)
  await core.pullsQueued(1)
  box.releaseApplies()
  await box.snapshotHeld()
  box.releaseSnapshots()
  box.holdSnapshots()
  // The tick's job ran and left the pulling to that backfill. Its next page fails offline.
  await box.snapshotHeld()
  box.setOffline(true)
  box.releaseSnapshots()
  t.equal(await core.idleWaits(2), [60, 120], "the backfill's failure backs the schedule off")
  box.setOffline(false)
  await sync(core)
  // How it settles is the push's business (see 18-undo-partial.ts). Here it only must.
  await core.settled(lost.change)
})

scenario(
  "a push that loses another change's answer after its pull leaves the scheduled pull to settle it",
  async (t) => {
    const { core, box } = await start(t)
    await core.idleWaits(1)
    const target = await thread(core, 'Can you review the draft?')
    const other = await thread(core, 'Lunch on Friday?')
    box.damageNextApplyAnswer('disconnect')
    box.holdApplies()
    const lost = await core.command({ kind: 'set-flags', threadIds: [target.id], unread: false })
    await box.applyHeld()
    const second = await core.command({ kind: 'set-flags', threadIds: [other.id], flagged: true })
    core.advanceClock(60)
    await core.pullsQueued(1)
    const pulls = box.calls().changes
    // The first answer is lost. The second change's push pulls first, which settles the first,
    // then carries the second, whose answer is lost too.
    box.releaseApplies()
    box.holdApplies()
    await box.applyHeld()
    // Settled before the second change's call went out, so awaited first: the order stays fixed.
    t.equal((await core.settled(lost.change)).result, 'done', "the push's pull settles the first change")
    box.damageNextApplyAnswer('disconnect')
    box.releaseApplies()
    t.equal(
      (await core.settled(second.change)).result,
      'done',
      "the tick's pull settles the second, without waiting a minute more",
    )
    t.equal(await core.idleWaits(2), [60, 60], 'and the schedule waits a minute')
    t.equal(box.calls().changes, pulls + 2, "the push's pull and the tick's")
  },
)

scenario("a pull the schedule queued before a sign-out does not run on the next sign-in's link", async (t) => {
  const { core, box, accountId } = await start(t)
  await core.idleWaits(1)
  const target = await thread(core, 'Can you review the draft?')
  box.holdApplies()
  const change = await core.command({ kind: 'set-flags', threadIds: [target.id], unread: false })
  await box.applyHeld()
  // The scheduled pull queues behind the held push.
  core.advanceClock(60)
  await core.pullsQueued(1)
  t.check((await core.request({ method: 'sign-out', accountId, deleteLocalMail: false })).ok, 'the account signs out')
  await signIn(t, core, ME, PASSWORD)
  const pulls = box.calls().changes
  box.releaseApplies()
  await core.settled(change.change)
  t.equal(await core.idleWaits(2), [60, 60], "the new link's first wait follows its sign-in's sync")
  t.equal(box.calls().changes, pulls + 1, "only the new sign-in's sync pulled")
})

scenario("the first wait starts once the sign-in's sync and its backfill end", async (t) => {
  const box = t.mailbox(standardSeed(t.dialect, { pageSize: 2 }))
  box.holdSnapshots()
  const core = t.startCore()
  await core.hello()
  await signIn(t, core, ME, PASSWORD)
  await box.snapshotHeld()
  // The sign-in's first page is held. A wait timed from the sign-in would have seen this move.
  core.advanceClock(30)
  box.releaseSnapshots()
  t.equal(await core.idleWaits(1), [60], 'the first wait is a minute')
  t.equal(await core.idleWaitStarts(1), [30], 'and it began after the clock moved, once the backfill ended')
})

scenario('routine pulls leave the accounts view idle, and a first sync or a resync shows syncing', async (t) => {
  const seed = standardSeed(t.dialect)
  const box = t.mailbox(seed)
  const core = t.startCore()
  await core.hello()
  // Every state the view goes through, each change once.
  const view = core.subscribe({ view: 'accounts' })
  const states: string[] = []
  view.watch(() => {
    const state = view.latest()?.[0]?.status.state
    if (state !== undefined && state !== states.at(-1)) states.push(state)
  })
  const synced = () => {
    const status = view.latest()?.[0]?.status
    return status && 'lastSyncedAt' in status ? status.lastSyncedAt : null
  }
  /** Waits for updates until `ready` holds. Each pull saves when it synced, so it updates the view. */
  const until = async (ready: () => boolean) => {
    while (!ready()) await view.next()
  }
  await signIn(t, core, seed.address, seed.password)
  await until(() => states.at(-1) === 'idle')
  await core.idleWaits(1)
  t.equal(states, ['syncing', 'idle'], 'the first sync shows syncing')
  for (const [count, key] of [
    [2, null],
    [3, null],
    [4, 'quiet'],
  ] as const) {
    // From a machine, so it tells no your-turn, which would race the checks here.
    const headers = { listUnsubscribe: true }
    if (key) box.deliver(fromBen(key, 'Quietly arrived', '2025-12-09T09:00:00.000Z', { headers }))
    const before = synced()
    core.advanceClock(60)
    await until(() => synced() !== before)
    await core.idleWaits(count)
  }
  t.equal(states, ['syncing', 'idle'], 'three pulls, two with nothing new and one with new mail, leave it idle')
  t.check((await thread(core, 'Quietly arrived')).subject === 'Quietly arrived', 'the new mail came in all the same')
  box.expireCursors()
  const before = synced()
  core.advanceClock(60)
  await until(() => synced() !== before && states.at(-1) === 'idle')
  await core.idleWaits(5)
  t.equal(states, ['syncing', 'idle', 'syncing', 'idle'], 'a pull that lists the mailbox again shows syncing')
})
