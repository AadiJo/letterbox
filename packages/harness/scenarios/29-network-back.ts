// The host says the network may be back (`network-back`): an account the schedule found offline
// pulls within seconds, not after the rest of its backoff (crates/core/src/schedule.rs). Ways it
// can go wrong: the hint does nothing, so mail waits out the backoff; it pulls healthy accounts,
// so every resume or reconnect costs a pull each; each hint of a burst pulls again, so a
// network that flaps brings a burst of pulls; it acts for an account that is not offline in a
// way the network explains: a pull under way, one that needs a sign-in, or one offline only
// from a push; or it runs beside the schedule, so a pull it brings misses what the schedule
// would have done, as health that clears while it waits.
//
// The hint only brings the schedule's next deadline forward. `noted` waits on the core's word
// that a hint did not hold, so each step is taken once it decided, never on time.
//
// The fixed clock holds every idle wait until the scenario moves it, and `idleWaits` lists the
// waits the schedule began (see 27-sync-schedule.ts).

import type { Subscription } from '../src/client.ts'
import type { Scenario } from '../src/scenario.ts'
import { fromBen, ME, signIn, start, sync, thread, untilAccounts } from '../src/fixtures.ts'
import { scenario } from '../src/scenario.ts'

/** Starts signed in, then takes the provider offline until the schedule backs off to 120 s. Leaves it offline. */
async function backedOff(t: Scenario) {
  const signedIn = await start(t)
  const { core, box } = signedIn
  await core.idleWaits(1)
  const accounts = core.subscribe({ view: 'accounts' })
  // Its first answer before the clock moves, so the view shows the same updates every run.
  await accounts.next()
  box.setOffline(true)
  core.advanceClock(60)
  await untilAccounts(accounts, (list) => list[0]?.status.state === 'offline')
  t.equal(await core.idleWaits(2), [60, 120], 'offline, the schedule backs off')
  return signedIn
}

/** Waits until the open list `view` holds a conversation with `subject`, and says so. */
async function untilListed(t: Scenario, view: Subscription<'threads'>, subject: string, what: string) {
  for (;;) {
    if (view.latest()?.threads.some((row) => row.subject === subject)) return t.check(true, what)
    await view.next()
  }
}

scenario('a network-back hint pulls an offline account within seconds, once for a burst of hints', async (t) => {
  const { core, box } = await start(t)
  await core.idleWaits(1)
  const accounts = core.subscribe({ view: 'accounts' })
  // Its first answer before the clock moves, so the view shows the same updates every run.
  await accounts.next()
  box.setOffline(true)
  core.advanceClock(60)
  await untilAccounts(accounts, (list) => list[0]?.status.state === 'offline')
  t.equal(await core.idleWaits(2), [60, 120], 'offline, the schedule backs off')
  box.deliver(fromBen('meanwhile', 'Sent while you were offline', '2025-12-09T09:00:00.000Z'))
  box.setOffline(false)
  const list = core.subscribe({ view: 'threads', filter: {}, offset: 0, limit: 500 })
  await list.next()

  // A resume and a reconnect send their hints together.
  t.check((await core.request({ method: 'network-back' })).ok, 'the core takes the hint')
  t.equal(await core.idleWaits(3), [60, 120, 2], 'the backoff gives way to a short settle')
  t.check((await core.request({ method: 'network-back' })).ok, 'and the next one')
  core.advanceClock(2)
  await untilListed(t, list, 'Sent while you were offline', 'the mail is listed once the settle ends')
  await core.take('your-turn')
  t.equal(
    await core.idleWaits(4),
    [60, 120, 2, 60],
    'the second hint began no wait of its own, and pulls are a minute apart again',
  )

  // Healthy now, a hint changes nothing: the next pull is still the minute's.
  t.check((await core.request({ method: 'network-back' })).ok, 'a hint while healthy is taken too')
  core.advanceClock(60)
  t.equal(await core.idleWaits(5), [60, 120, 2, 60, 60], 'and leaves the minute as it was')
})

scenario('a network-back hint that finds the provider still offline backs off further', async (t) => {
  const { core, box } = await start(t)
  await core.idleWaits(1)
  const accounts = core.subscribe({ view: 'accounts' })
  // Its first answer before the clock moves, so the view shows the same updates every run.
  await accounts.next()
  box.setOffline(true)
  core.advanceClock(60)
  await untilAccounts(accounts, (list) => list[0]?.status.state === 'offline')
  t.equal(await core.idleWaits(2), [60, 120], 'offline, the schedule backs off')
  t.check((await core.request({ method: 'network-back' })).ok, 'the core takes the hint')
  t.equal(await core.idleWaits(3), [60, 120, 2], 'the backoff gives way to a short settle')
  core.advanceClock(2)
  t.equal(
    await core.idleWaits(4),
    [60, 120, 2, 240],
    'the pull finds it offline, and the backoff goes on from where it was',
  )
})

scenario('a network-back hint that comes while a pull is under way is ignored', async (t) => {
  const { core, box } = await backedOff(t)
  box.setOffline(false)
  // A sync-now's pull is under way: its snapshot page is held.
  box.expireCursors()
  box.holdSnapshots()
  const syncing = core.begin({ method: 'sync-now' })
  await box.snapshotHeld()
  t.check((await core.request({ method: 'network-back' })).ok, 'the core takes the hint')
  await core.noted('hint-ignored', 1)
  // The pull under way finds the provider offline after all.
  box.setOffline(true)
  box.releaseSnapshots()
  t.equal((await syncing.done).ok, false, 'the sync finds it offline')
  core.advanceClock(120)
  t.equal(await core.idleWaits(3), [60, 120, 240], 'no second pull came of the hint: the backoff went on as it was')
})

scenario('a network-back hint is ignored when only a push found the provider offline', async (t) => {
  const { core, box } = await start(t)
  await core.idleWaits(1)
  const accounts = core.subscribe({ view: 'accounts' })
  box.setOffline(true)
  const target = await thread(core, 'Can you review the draft?')
  await core.command({ kind: 'set-flags', threadIds: [target.id], unread: false })
  await untilAccounts(accounts, (list) => list[0]?.status.state === 'offline')
  box.setOffline(false)
  t.check((await core.request({ method: 'network-back' })).ok, 'the core takes the hint')
  await core.noted('hint-ignored', 1)
  // The last pull went well, so the minute's pull is next, and it carries the change too.
  core.advanceClock(60)
  t.equal(await core.idleWaits(2), [60, 60], 'no settle came of the hint')
})

scenario(
  'on gmail, a network-back hint is ignored while the account needs a sign-in',
  async (t) => {
    const gmail = t.gmail
    if (!gmail) throw new Error('this scenario runs as gmail only')
    const { core, box } = await backedOff(t)
    box.setOffline(false)
    // The user removes the app's access, and a change's push finds out.
    const accounts = core.subscribe({ view: 'accounts' })
    await accounts.next()
    gmail.revokeAccess(ME)
    gmail.expireAccessTokens()
    const target = await thread(core, 'Can you review the draft?')
    const change = await core.command({ kind: 'set-flags', threadIds: [target.id], unread: false })
    await untilAccounts(accounts, (list) => list[0]?.status.state === 'needs-sign-in')
    t.check((await core.request({ method: 'network-back' })).ok, 'the core takes the hint')
    await core.noted('hint-ignored', 1)
    // Signing in again picks up the change.
    await signIn(t, core, ME, '')
    await sync(core)
    t.equal((await core.settled(change.change)).result, 'done', 'after a new sign-in the change reaches Gmail')
  },
  ['gmail'],
)

scenario('health a push clears while a hint is pending brings the pull at once, as without the hint', async (t) => {
  const { core, box } = await backedOff(t)
  box.deliver(fromBen('meanwhile', 'Sent while you were offline', '2025-12-09T09:00:00.000Z'))
  box.setOffline(false)
  const list = core.subscribe({ view: 'threads', filter: {}, offset: 0, limit: 500 })
  await list.next()
  t.check((await core.request({ method: 'network-back' })).ok, 'the core takes the hint')
  t.equal(await core.idleWaits(3), [60, 120, 2], 'the next pull is brought forward')
  // Before that deadline, a change reaches the provider, which clears the health.
  const target = await thread(core, 'Can you review the draft?')
  const change = await core.command({ kind: 'set-flags', threadIds: [target.id], unread: false })
  t.equal((await core.settled(change.change)).result, 'done', 'the change reaches the provider')
  t.equal(await core.idleWaits(4), [60, 120, 2, 0], 'the health that cleared makes the pull due at once')
  core.advanceClock(0)
  await untilListed(t, list, 'Sent while you were offline', 'the pull brings the mail')
  await core.take('your-turn')
  t.equal(await core.idleWaits(5), [60, 120, 2, 0, 60], 'and pulls are a minute apart again')
})
