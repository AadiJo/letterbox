// The first sync of a large mailbox: newest mail first, then a backfill of the rest,
// one snapshot page per queue job, with the progress saved after each page.
//
// Ways it can go wrong, each checked below or by an older scenario:
//   1. Pages wait in memory until the last one, so a failure part way loses them all.
//   2. The page token is not saved, so a failure or a restart starts the snapshot over.
//   3. A resumed snapshot asks for the wrong page: one it already has, or one too far.
//   4. The cursor is set before the last page, so the rest of the mailbox never arrives.
//   5. Messages the snapshot has not listed yet are removed part way, as if gone.
//   6. A re-snapshot that gives every message a new ref (folders) mints new ids.
//   7. The backfill holds the account's queue, so the user's change waits for all of it.
//   8. Changes made during a backfill reach the provider out of order.
//   9. A sign-out during a backfill does not stop it, and its page writes mail back.
//  10. A page token the provider no longer accepts is retried forever, or ends the sync.
//  11. The provider lists oldest first, so recent mail shows last.
//  12. The account shows idle, or a sync-now is answered, before the backfill ends.
//  13. A sign-in pass and a sync-now each run a chain of pages, so pages are fetched twice.
//
// Every scenario here holds snapshot pages at the provider to stop the backfill at a
// known page. Six messages at two per page make three pages, newest first:
//   page 1  fyi, newsletter    page 2  review, lunch-answer    page 3  lunch-ask, photos

import type { SimMailbox } from '@letterbox/sim-provider/contract'
import type { ThreadSummary } from '@letterbox/protocol'
import type { CoreClient } from '../src/client.ts'
import {
  ME,
  PASSWORD,
  signIn,
  standardSeed,
  start,
  sync,
  thread,
  threads,
  truthOf,
  untilAccounts,
} from '../src/fixtures.ts'
import { type Scenario, scenario } from '../src/scenario.ts'

const ALL = ['Budget numbers', 'December offers', 'Can you review the draft?', 'Lunch on Friday?', 'Trip photos']
const FIRST_PAGE = ['Budget numbers', 'December offers']
// Page 2 holds the answer to lunch, so the conversation is named after it until page 3 brings the question.
const FIRST_TWO_PAGES = [...FIRST_PAGE, 'Can you review the draft?', 'Re: Lunch on Friday?']

const subjects = (list: ThreadSummary[]) => list.map((item) => item.subject)

/** Answers the snapshot page the provider holds, and holds the next one. Resolves once the core asks for it. */
async function nextPage(box: SimMailbox) {
  box.releaseSnapshots()
  box.holdSnapshots()
  await box.snapshotHeld()
}

/** Seeds a three-page mailbox, starts a core, and signs in with snapshot pages held. Resolves with page 1 held. */
async function signInHeld(t: Scenario): Promise<{ core: CoreClient; box: SimMailbox }> {
  const box = t.mailbox(standardSeed(t.dialect, { pageSize: 2 }))
  box.holdSnapshots()
  const core = t.startCore()
  await core.hello()
  await signIn(t, core, ME, PASSWORD)
  await box.snapshotHeld()
  return { core, box }
}

scenario('a failure in the middle of the first sync keeps the pages before it', async (t) => {
  const box = t.mailbox(standardSeed(t.dialect, { pageSize: 2 }))
  box.holdSnapshots()
  const core = t.startCore()
  await core.hello()
  const accounts = core.subscribe({ view: 'accounts' })
  await signIn(t, core, ME, PASSWORD)
  await box.snapshotHeld()
  await nextPage(box)
  await nextPage(box)
  box.setOffline(true)
  box.releaseSnapshots()
  await untilAccounts(accounts, (list) => ['offline', 'error'].includes(list[0]?.status.state ?? ''))
  t.equal(subjects(await threads(core)), FIRST_TWO_PAGES, 'the two pages before the failure are shown')
  box.setOffline(false)
  await sync(core)
  t.equal(subjects(await threads(core)), ALL, 'the next sync brought the rest')
  t.equal(box.calls().snapshot, 3, 'it asked for the third page only, not the first two again')
})

scenario('a restart in the middle of the first sync resumes from the saved page', async (t) => {
  const first = await signInHeld(t)
  await nextPage(first.box)
  const stopped = first.core.stop()
  await first.core.inputClosed()
  first.box.releaseSnapshots()
  await stopped
  t.equal(first.box.calls().snapshot, 2, 'the stopping core finished the page in flight and asked for no more')

  const core = t.startCore()
  await core.hello()
  t.equal(subjects(await threads(core)), FIRST_TWO_PAGES, 'the two pages are there after the restart')
  await sync(core)
  t.equal(subjects(await threads(core)), ALL, 'the sync after the restart brought the rest')
  t.equal(first.box.calls().snapshot, 3, 'it asked for the third page only')
})

scenario('the newest mail shows first while older mail backfills', async (t) => {
  const { core, box } = await signInHeld(t)
  await nextPage(box)
  t.equal(subjects(await threads(core)), FIRST_PAGE, 'the two newest conversations show before the backfill ends')
  const account = (await core.query({ view: 'accounts' }))[0]
  t.equal(
    account?.status,
    { state: 'syncing', done: 2, total: null, lastSyncedAt: null },
    'the account shows the backfill under way, with the messages listed so far',
  )
  box.releaseSnapshots()
  await sync(core)
  t.equal(subjects(await threads(core)), ALL, 'the backfill brought the older mail')
  t.equal(box.calls().snapshot, 3, 'each page was asked for once')
  t.equal((await core.query({ view: 'accounts' }))[0]?.status.state, 'idle', 'the account is idle once it ends')
})

scenario('a change made during a backfill reaches the provider before the backfill ends', async (t) => {
  const { core, box } = await signInHeld(t)
  await nextPage(box)
  const target = await thread(core, 'Budget numbers')
  // Two changes to the same flag: the provider ends with the second only if they arrive in order.
  const read = await core.command({ kind: 'set-flags', threadIds: [target.id], unread: false })
  const unread = await core.command({ kind: 'set-flags', threadIds: [target.id], unread: true })
  await nextPage(box)
  t.equal((await core.settled(read.change)).result, 'done', 'the first change settled between pages')
  t.equal((await core.settled(unread.change)).result, 'done', 'the second change settled between pages')
  // The provider counts a call when it answers it.
  t.equal(box.calls().snapshot, 2, 'the last page is still held, so the backfill has not ended')
  t.equal(
    [box.calls().apply, truthOf(box, 'fyi')?.unread],
    [2, true],
    'the provider has both changes, in the order they were made',
  )
  box.releaseSnapshots()
  await sync(core)
  t.equal(subjects(await threads(core)), ALL, 'the backfill finished after the changes')
  t.equal((await thread(core, 'Budget numbers')).unread, true, 'the conversation shows the last change')
})

scenario('a sign-out during a backfill stops it and writes nothing more', async (t) => {
  const { core, box } = await signInHeld(t)
  const accountId = (await core.query({ view: 'accounts' }))[0]?.id
  if (!accountId) throw new Error('no account after the sign-in')
  await nextPage(box)
  const signedOut = await core.request({ method: 'sign-out', accountId, deleteLocalMail: true })
  t.check(signedOut.ok, 'the sign-out is answered while a page is in flight')
  t.equal((await threads(core)).length, 0, 'the mail is gone at once')
  const stopped = core.stop()
  await core.inputClosed()
  box.releaseSnapshots()
  await stopped
  t.equal(box.calls().snapshot, 2, 'no page was asked for after the sign-out')

  const again = t.startCore()
  await again.hello()
  t.equal((await again.query({ view: 'accounts' })).length, 0, 'no account came back')
  t.equal((await threads(again)).length, 0, 'the page in flight wrote no mail back')
})

scenario('a re-snapshot removes deleted mail only once it completes', async (t) => {
  const { core, box } = await start(t, standardSeed(t.dialect, { pageSize: 2 }))
  const kept = await thread(core, 'Can you review the draft?')
  box.expunge('newsletter')
  box.expireCursors()
  box.holdSnapshots()
  const syncing = core.begin({ method: 'sync-now' })
  await box.snapshotHeld()
  await nextPage(box)
  t.equal(
    subjects(await threads(core)),
    ALL,
    'part way, every conversation is still there, the deleted one too and those not listed yet',
  )
  box.releaseSnapshots()
  const done = await syncing.done
  t.check(done.ok, 'the sync is answered once the snapshot ends')
  t.equal(
    subjects(await threads(core)),
    ALL.filter((subject) => subject !== 'December offers'),
    'once it completes, the deleted conversation is gone',
  )
  t.equal((await thread(core, 'Can you review the draft?')).id, kept.id, 'a listed conversation kept its id')
})

scenario('a page token the provider no longer accepts starts the snapshot over', async (t) => {
  const { core, box } = await signInHeld(t)
  await nextPage(box)
  const before = await thread(core, 'Budget numbers')
  box.expirePageTokens()
  // Sent while the page is held, so the sync queues behind the page in flight.
  const syncing = core.begin({ method: 'sync-now' })
  box.releaseSnapshots()
  const done = await syncing.done
  t.check(done.ok, 'the sync is answered once the new snapshot ends')
  t.equal(subjects(await threads(core)), ALL, 'the new snapshot listed the whole mailbox')
  t.equal(box.calls().snapshot, 5, 'the dead token was asked for once, then three pages from the first')
  t.equal((await thread(core, 'Budget numbers')).id, before.id, 'a conversation listed twice kept its id')
})
