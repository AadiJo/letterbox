// The host says the network may be back (`network-back`): an account the schedule found offline
// pulls within seconds, not after the rest of its backoff (crates/core/src/schedule.rs). Ways it
// can go wrong: the hint does nothing, so mail waits out the backoff; it pulls healthy accounts,
// so every resume or reconnect costs a pull each; or each hint of a burst pulls again, so a
// network that flaps brings a burst of pulls.
//
// The fixed clock holds every idle wait until the scenario moves it, and `idleWaits` lists the
// waits the schedule began (see 27-sync-schedule.ts).

import type { Subscription } from '../src/client.ts'
import type { Scenario } from '../src/scenario.ts'
import { fromBen, start, untilAccounts } from '../src/fixtures.ts'
import { scenario } from '../src/scenario.ts'

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
