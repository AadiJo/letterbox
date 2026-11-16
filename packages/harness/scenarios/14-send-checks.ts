// The checks that confirm a send that may have reached the provider: how many lookups they
// make, and how they end. Each scenario fixes the order of events with held provider calls,
// held waits, a moved clock, and a sync whose answer comes after the checks queued before it.

import type { ChangeId } from '@letterbox/protocol'
import { sync } from '../src/fixtures.ts'
import { scenario } from '../src/scenario.ts'
import { cutOff, draft } from '../src/sending.ts'

/** Two hours on from where a fixed clock starts: past a one-minute confirm window, inside a four-hour one. */
const LATER = '2026-01-01T02:00:00.000Z'
/** Past a four-hour confirm window opened near where a fixed clock starts. */
const MUCH_LATER = '2026-01-01T05:00:00.000Z'
/** A four-hour confirm window. Its checks come an hour apart, which core-sim holds back, so only checks a start books happen. */
const LONG_WINDOW = 4 * 3600

scenario('a last lookup that fails after the window ends still fails the send as unconfirmed', async (t) => {
  const { box, change } = await cutOff(t)
  // Held waits: this core marks the send unconfirmed and looks once, and its next check never comes.
  const second = t.startCore({ holdWaits: true })
  await second.hello()
  await sync(second)
  await second.stop()

  box.failNextFind()
  const core = t.startCore({ now: LATER })
  await core.hello()
  t.equal(
    (await core.settled(change)).result,
    { failed: 'unconfirmed' },
    'its window is over, so a failed last lookup fails it, as an empty one would',
  )
  t.equal(box.calls().send, 0, 'it was not sent again')
  box.releaseSends()
  t.equal(box.sent().length, 1, 'the provider holds the first send only')
})

scenario('three unconfirmed sends are looked up once each per round, before and after restarts', async (t) => {
  const first = await cutOff(t)
  const { box, accountId } = first
  const changes: ChangeId[] = [first.change]

  // Two more sends, each cut off by killing the core that made it. The provider holds all three.
  for (const [index, subject] of ['Second note', 'Third note'].entries()) {
    const core = t.startCore({ confirmWindow: LONG_WINDOW })
    await core.hello()
    const send = await core.command({ kind: 'send', draft: draft(accountId, null, { subject }) })
    changes.push(send.change)
    await box.sendHeld(index + 2)
    await core.kill()
  }

  /**
   * Starts a core and returns how many lookups it made. Two syncs queue behind the checks its
   * start booked and behind any check the first sync's pass books, so every lookup is counted.
   */
  const round = async (now?: string) => {
    const before = box.calls().find
    const core = t.startCore({ confirmWindow: LONG_WINDOW, ...(now === undefined ? {} : { now }) })
    await core.hello()
    await sync(core)
    await sync(core)
    return { core, lookups: box.calls().find - before }
  }

  const fresh = await round()
  t.equal(fresh.lookups, 3, 'a start looks each of the three up once, not once per send per send')
  await fresh.core.stop()
  const restarted = await round(LATER)
  t.equal(restarted.lookups, 3, 'a restart inside their windows looks each up once again')
  await restarted.core.stop()

  const last = await round(MUCH_LATER)
  t.equal(last.lookups, 3, 'past their windows, each is looked up once more')
  for (const change of changes) {
    t.equal((await last.core.settled(change)).result, { failed: 'unconfirmed' }, `${change} fails as unconfirmed`)
  }
  t.equal(box.calls().send, 0, 'none of them was sent again')
})
