// One sender's Updates row (crates/core/src/senders.rs): a senders view with `address` holds
// only that sender, compared without case, wherever it sits among the others, and follows where
// an unsubscribe from it has got. A UI reads a conversation's sender's state by it.

import { mailbox } from '../src/fixtures.ts'
import { HELD_WINDOW, scenario } from '../src/scenario.ts'
import { accept } from '../src/undoing.ts'
import { begin, unsubscribe } from '../src/unsubscribing.ts'

scenario(
  'a senders view of one address holds that sender alone, wherever it sits, and follows its unsubscribe',
  async (t) => {
    const { core } = await begin(t, { undoWindow: HELD_WINDOW })
    const inbox = await mailbox(core, 'Inbox')
    const all = await core.query({ view: 'senders', mailboxId: inbox.id, offset: 0, limit: 50 })
    const oldest = all.senders.at(-1)
    t.equal(
      [all.total > 1, oldest?.address],
      [true, 'site@x.github.io'],
      'the seed lists many senders, the one at x.github.io last',
    )

    // Written in other case, as a From can be: the view compares without case.
    const one = core.subscribe({
      view: 'senders',
      mailboxId: inbox.id,
      address: 'Site@X.GitHub.io',
      offset: 0,
      limit: 1,
    })
    const first = one.latest() ?? (await one.next())
    t.equal(
      [first.total, first.senders.map((sender) => [sender.address, sender.threads, sender.unsubscribed])],
      [1, [['site@x.github.io', oldest?.threads, null]]],
      "a view of one address holds that sender's row alone, as the full list has it, though it is the last",
    )

    const change = await unsubscribe(t, core, 'Site notes')
    let page = one.latest() ?? first
    while (page.senders[0]?.unsubscribed?.state !== 'held') page = await one.next()
    t.equal(
      page.senders[0]?.unsubscribed?.state === 'held' && page.senders[0].unsubscribed.change,
      change,
      'it follows the unsubscribe: held, under its change',
    )
    one.close()
    // Taken back, so it settles before the scenario ends.
    const undo = await accept(t, core, { kind: 'undo', change }, 'the undo')
    t.equal(
      [(await core.settled(change)).result, (await core.settled(undo)).result],
      ['undone', 'done'],
      'undone, it settles',
    )

    const none = await core.query({
      view: 'senders',
      mailboxId: inbox.id,
      address: 'nobody@else.example',
      offset: 0,
      limit: 1,
    })
    t.equal([none.total, none.senders], [0, []], 'an address with no row in Updates has an empty view')
  },
)
