// Lists a UI keeps open while the mail under them changes. The core keeps each open
// list's threads between commits and updates them from what each commit touched, so
// an open list must always show what a list opened afresh would.

import type { ThreadFilter } from '@letterbox/protocol'
import { fromBen, mailbox, start, sync, thread } from '../src/fixtures.ts'
import { scenario } from '../src/scenario.ts'

scenario('an open list follows threads into and out of its filter', async (t) => {
  const { core, box } = await start(t)
  const inbox = await mailbox(core, 'Inbox')
  const windows: [name: string, filter: ThreadFilter, offset: number, limit: number][] = [
    ['every thread', {}, 0, 50],
    ['the second and third thread', {}, 1, 2],
    ['unread', { unread: true }, 0, 50],
    ['in the inbox', { mailboxId: inbox.id }, 0, 50],
    ['my turn', { turn: 'mine' }, 0, 50],
  ]
  const open = await Promise.all(
    windows.map(async ([name, filter, offset, limit]) => {
      const list = core.subscribe({ view: 'threads', filter, offset, limit })
      await list.next()
      return { name, filter, offset, limit, list }
    }),
  )
  /** Checks each open list against the same list opened now. */
  const agree = async (when: string) => {
    for (const { name, filter, offset, limit, list } of open) {
      const fresh = await core.query({ view: 'threads', filter, offset, limit })
      t.equal(list.latest(), fresh, `${when}: the open "${name}" list shows what a new one would`)
    }
  }
  await agree('synced')

  const review = await thread(core, 'Can you review the draft?')
  const read = await core.command({ kind: 'set-flags', threadIds: [review.id], unread: false })
  t.equal((await core.settled(read.change)).result, 'done', 'marking read settles')
  await agree('read')

  const archive = await core.command({ kind: 'set-mailboxes', threadIds: [review.id], add: [], remove: [inbox.id] })
  t.equal((await core.settled(archive.change)).result, 'done', 'archiving settles')
  await agree('archived')

  const copied = await thread(core, 'Budget numbers')
  const mine = await core.command({ kind: 'set-turn', threadIds: [copied.id], turn: 'mine' })
  t.equal((await core.settled(mine.change)).result, 'done', 'the turn correction settles')
  await agree('turn set to mine')
  const auto = await core.command({ kind: 'set-turn', threadIds: [copied.id], turn: 'auto' })
  t.equal((await core.settled(auto.change)).result, 'done', 'handing the turn back settles')
  await agree('turn handed back')

  box.deliver(fromBen('standup', 'Standup moved to 10', '2025-12-05T09:00:00.000Z'))
  await sync(core)
  await agree('new mail arrived')
})
