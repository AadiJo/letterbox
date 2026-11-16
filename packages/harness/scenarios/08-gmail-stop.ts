// Stopping the core while a Gmail call waits out a rate limit. The core lets its work in
// flight finish before it exits (Core::close), and one call can wait minutes, so every
// adapter stops waiting first: the waiting call answers offline, and the page or change
// it was for stays saved for the next start.
//
// Ways it can go wrong, each checked below or by an older scenario:
//   1. The close waits for the rate-limit wait to end, so the core does not exit.
//   2. Only the call waiting now gives up, and the next call refused waits again.
//   3. The adapters close first instead, so work queued behind the waiting call fails
//      without reaching the provider ('bodies still loading when the core stops' in 01-sync.ts).
//   4. The page that gave up loses the saved progress, so the next start lists from page 1.
//   5. A change queued behind it is dropped or settled as failed, not kept for the next start.
//
// Six messages at two per page make three pages, newest first (see 07-backfill.ts).

import type { ThreadSummary } from '@letterbox/protocol'
import { ME, PASSWORD, signIn, standardSeed, sync, thread, threads, truthOf } from '../src/fixtures.ts'
import { scenario } from '../src/scenario.ts'

const ALL = ['Budget numbers', 'December offers', 'Can you review the draft?', 'Lunch on Friday?', 'Trip photos']
const FIRST_PAGE = ['Budget numbers', 'December offers']

const subjects = (list: ThreadSummary[]) => list.map((item) => item.subject)

scenario(
  'a gmail stop during a rate-limit wait exits at once, and the next start finishes the sync',
  async (t) => {
    const gmail = t.gmail
    if (!gmail) throw new Error('this scenario runs as gmail only')
    const box = t.mailbox(standardSeed(t.dialect, { pageSize: 2 }))
    box.holdSnapshots()
    const first = t.startCore()
    await first.hello()
    await signIn(t, first, ME, PASSWORD)
    await box.snapshotHeld()
    box.releaseSnapshots()
    box.holdSnapshots()
    await box.snapshotHeld()
    // Page 1 is stored. Page 2's list passed Gmail's quota check and is held there.
    const target = await thread(first, 'Budget numbers')
    const read = await first.command({ kind: 'set-flags', threadIds: [target.id], unread: false })
    // An hour's Retry-After: core-sim's wait for it holds until the adapter stops waiting.
    gmail.setQuota(ME, { units: 0, retryAfter: 3600 })
    box.releaseSnapshots()
    await first.waitHeld()
    await first.stop()
    t.equal(
      gmail.refusals(ME),
      2,
      'the core exited: page 2 stopped waiting, and the change queued behind it was refused once without a wait',
    )

    gmail.setQuota(ME, null)
    const core = t.startCore()
    await core.hello()
    t.equal(subjects(await threads(core)), FIRST_PAGE, 'page 1 is there after the restart')
    t.equal((await thread(core, 'Budget numbers')).pending, true, 'the change is still pending')
    await sync(core)
    t.equal((await core.settled(read.change)).result, 'done', 'the change settles on the next start')
    t.equal(truthOf(box, 'fyi')?.unread, false, 'Gmail holds it')
    t.equal(subjects(await threads(core)), ALL, 'the sync finished the snapshot')
    t.equal(box.calls().snapshot, 4, 'it resumed from page 2, so page 1 was listed once')
  },
  ['gmail'],
)
