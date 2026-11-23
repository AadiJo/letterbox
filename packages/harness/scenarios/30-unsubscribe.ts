// Unsubscribing from a sender (crates/core/src/unsubscribe): the hold and its undo, a restart,
// what the core will not send, the page it only offers, and one core per store. The user
// confirms, the core holds the request for the send undo window, then carries it out once. Its
// DKIM check is in 30-unsubscribe-dkim.ts. Every POST goes to the fake web.

import { sync } from '../src/fixtures.ts'
import { HELD_WINDOW, scenario } from '../src/scenario.ts'
import { accept } from '../src/undoing.ts'
import { begin, messageOf, row, traffic, unsubscribe } from '../src/unsubscribing.ts'

scenario('an unsubscribe held for its window is undone, and nothing leaves the device', async (t) => {
  const { core, box } = await begin(t, { undoWindow: HELD_WINDOW })
  t.equal((await row(core, 'news@list.example'))?.unsubscribed, null, 'before, the row shows no unsubscribe')

  const change = await unsubscribe(t, core, 'Weekly news')
  const held = (await row(core, 'news@list.example'))?.unsubscribed
  t.equal(
    held?.state === 'held' && [held.change, held.method],
    [change, 'one-click'],
    'the row shows it held, by one-click, under its change',
  )
  t.equal(
    (await core.command({ kind: 'unsubscribe', messageId: await messageOf(core, 'Weekly news') })).kind,
    'rejected',
    'a second unsubscribe from the same sender is refused while one is held',
  )

  const undo = await accept(t, core, { kind: 'undo', change }, 'the undo')
  t.equal(
    [(await core.settled(change)).result, (await core.settled(undo)).result],
    ['undone', 'done'],
    'the unsubscribe settles undone and the undo done',
  )
  t.equal((await row(core, 'news@list.example'))?.unsubscribed, null, 'the row offers the button again')
  t.equal(traffic(t, box), { posted: 0, lookups: 0, raw: 0, sent: 0 }, 'nothing was posted, looked up, fetched or sent')
})

scenario('a one-click unsubscribe at a private address is refused, and a redirect is not followed', async (t) => {
  const { core } = await begin(t)
  const change = await unsubscribe(t, core, 'Alerts')
  t.equal((await core.settled(change)).result, { failed: 'not-public' }, 'it fails not-public')
  t.equal([t.web.posted(), t.web.requested()], [[], []], 'nothing was sent to the host')
  t.equal((await row(core, 'alerts@intranet.example'))?.unsubscribed, null, 'the row offers the button again')

  const moved = await unsubscribe(t, core, 'Moved list')
  t.equal(
    (await core.settled(moved)).result,
    { failed: 'refused-by-provider' },
    'a redirect, which RFC 8058 forbids, fails it',
  )
  t.equal(
    [t.web.posted().map((post) => post.url), t.web.requested()],
    [['https://list.example/u/6'], []],
    'the POST went once, and the redirect was not followed',
  )
})

scenario("an unsubscribe's POST cut off by a stopped core is never sent again", async (t) => {
  const first = await begin(t)
  const held = t.web.hold('https://list.example/u/1')
  const change = await unsubscribe(t, first.core, 'Weekly news')
  await held.arrived
  await first.core.kill()
  held.release()

  const core = t.startCore()
  await core.hello()
  t.equal(
    (await core.settled(change)).result,
    { failed: 'unconfirmed' },
    'after the restart it fails unconfirmed: it may have arrived',
  )
  t.equal(t.web.posted().length, 1, 'it was posted once')
  t.equal((await row(core, 'news@list.example'))?.unsubscribed, null, 'the row offers the button again')
})

scenario('a web unsubscribe keeps its page for the user, and the core opens nothing', async (t) => {
  const first = await begin(t)
  const change = await unsubscribe(t, first.core, 'Daily digest')
  t.equal((await first.core.settled(change)).result, 'done', 'it settles done once its page is kept')
  const page = { state: 'page', change, url: 'https://list.example/u/5' } as const
  t.equal((await row(first.core, 'digest@list.example'))?.unsubscribed, page, 'the row offers the page, not done')
  t.equal(traffic(t, first.box), { posted: 0, lookups: 0, raw: 0, sent: 0 }, 'the core itself sent nothing')
  // An open-url naming a change is no message the protocol has, so the schema check fails any.
  await first.core.stop()
  const core = t.startCore()
  await core.hello()
  t.equal(
    (await row(core, 'digest@list.example'))?.unsubscribed,
    page,
    'after a restart the page is still only offered',
  )
})

scenario(
  'an unsubscribe held across a restart can still be undone, and one past its window goes out at start',
  async (t) => {
    const first = await begin(t, { undoWindow: HELD_WINDOW })
    const kept = await unsubscribe(t, first.core, 'Weekly news')
    const held = (await row(first.core, 'news@list.example'))?.unsubscribed
    await first.core.stop()

    const second = t.startCore({ undoWindow: HELD_WINDOW })
    await second.hello()
    t.equal(
      (await row(second, 'news@list.example'))?.unsubscribed,
      held,
      'after a restart it is held to the same deadline',
    )
    const undo = await accept(t, second, { kind: 'undo', change: kept }, 'the undo after the restart')
    t.equal(
      [(await second.settled(kept)).result, (await second.settled(undo)).result],
      ['undone', 'done'],
      'it is undone',
    )
    const due = await unsubscribe(t, second, 'Weekly news')
    await second.stop()
    t.equal(traffic(t, first.box), { posted: 0, lookups: 0, raw: 0, sent: 0 }, 'nothing left the device so far')

    // Two hours on, past the held window: the restarted core carries it out at once.
    const third = t.startCore({ now: '2026-01-01T02:00:00.000Z' })
    await third.hello()
    t.equal((await third.settled(due)).result, 'done', 'it goes out as the core starts, and settles done')
    t.equal(t.web.posted().length, 1, 'it was posted once')
  },
)

scenario("an unsubscribe's mail cut off by a stopped core is looked up, not sent again", async (t) => {
  const first = await begin(t)
  first.box.holdSends()
  const change = await unsubscribe(t, first.core, 'Deals')
  await first.box.sendHeld()
  await first.core.kill()

  const core = t.startCore({ holdWaits: true })
  await core.hello()
  await sync(core)
  t.equal(first.box.sent(), [], 'the restarted core looked it up, found nothing, and did not send it again')
  t.check(first.box.calls().find >= 1, 'it looked the mail up by its Message-ID')
  first.box.releaseSends()
  await sync(core)
  t.equal((await core.settled(change)).result, 'done', 'the sync that brings its copy settles it done')
  t.equal([first.box.sent().length, first.box.calls().send], [1, 1], 'the provider was asked to send it once')
})

scenario('a second core on the same store is refused, so one unsubscribe goes out from one core', async (t) => {
  const { core } = await begin(t)
  const second = t.startCore()
  await second.stop()
  t.equal(second.exitCode(), 1, 'the second core exits with an error')
  t.check(second.log().includes('another core has this store open'), 'it says another core has the store')
  const change = await unsubscribe(t, core, 'Weekly news')
  t.equal((await core.settled(change)).result, 'done', 'the first core carries on')
  t.equal(t.web.posted().length, 1, 'one POST went out')
})
