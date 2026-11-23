// One unsubscribe per sender (`plan` in crates/core/src/unsubscribe): while one is held or
// sending, another is refused `conflict`. Once one is done, or left its page, another is refused
// `already-unsubscribed`, and nothing more leaves the device. Only when the newest was undone or
// failed may the user ask again.

import type { Command } from '@letterbox/protocol'
import type { CoreClient } from '../src/client.ts'
import { HELD_WINDOW, scenario } from '../src/scenario.ts'
import { accept } from '../src/undoing.ts'
import { begin, messageOf, traffic, unsubscribe } from '../src/unsubscribing.ts'

/** The core's first answer to a second unsubscribe from the sender of `subject`: accepted, or the refusal's reason. */
async function again(core: CoreClient, subject: string) {
  const command: Command = { kind: 'unsubscribe', messageId: await messageOf(core, subject) }
  const answer = await core.command(command)
  return answer.kind === 'rejected' ? answer.reason : answer
}

scenario('a sender already unsubscribed from, done or left at its page, is refused another', async (t) => {
  const { core, box } = await begin(t)
  const done = await unsubscribe(t, core, 'Weekly news')
  t.equal((await core.settled(done)).result, 'done', 'a signed one-click is done')
  const page = await unsubscribe(t, core, 'Daily digest')
  t.equal((await core.settled(page)).result, 'done', 'a web unsubscribe settles once its page is kept')
  const before = traffic(t, box)
  t.equal(
    [await again(core, 'Weekly news'), await again(core, 'Daily digest')],
    ['already-unsubscribed', 'already-unsubscribed'],
    'a second unsubscribe from either is refused already-unsubscribed',
  )
  t.equal(
    [traffic(t, box), t.web.posted().map((post) => post.url)],
    [before, ['https://list.example/u/1']],
    'nothing more left the device: the one POST is the first one',
  )
})

scenario('a sender whose unsubscribe failed may be asked again', async (t) => {
  const { core } = await begin(t)
  const first = await unsubscribe(t, core, 'Alerts')
  t.equal((await core.settled(first)).result, { failed: 'not-public' }, 'the first fails not-public')
  const second = await again(core, 'Alerts')
  if (typeof second === 'string') throw new Error(`the second was refused ${second}`)
  t.equal(
    [second.kind, (await core.settled(second.change)).result],
    ['accepted', { failed: 'not-public' }],
    'a second is accepted, and settles as the first did',
  )
})

scenario('a sender whose unsubscribe was undone may be asked again', async (t) => {
  const { core } = await begin(t, { undoWindow: HELD_WINDOW })
  const first = await unsubscribe(t, core, 'Weekly news')
  t.equal(await again(core, 'Weekly news'), 'conflict', 'while the first is held, another is refused conflict')
  const undo = await accept(t, core, { kind: 'undo', change: first }, 'the undo')
  t.equal(
    [(await core.settled(first)).result, (await core.settled(undo)).result],
    ['undone', 'done'],
    'the first is undone',
  )
  const second = await unsubscribe(t, core, 'Weekly news')
  // Taken back too, so it settles before the scenario ends.
  const undoAgain = await accept(t, core, { kind: 'undo', change: second }, 'the second undo')
  t.equal(
    [(await core.settled(second)).result, (await core.settled(undoAgain)).result],
    ['undone', 'done'],
    'a second is accepted and held, and can be undone in turn',
  )
})
