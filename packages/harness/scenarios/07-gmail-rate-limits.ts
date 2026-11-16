// Gmail's usage limits. The fake refuses calls over a scenario's budget with the 403
// rateLimitExceeded a live run got, or with another limit a scenario names (quota.ts).
// The adapter must wait out a per-minute or per-user limit and try the same call again,
// and must not wait out a daily one (crates/gmail/src/api.rs). core-sim's waits return at once, except a wait for a
// Retry-After of an hour or more, which holds until the adapter closes and tells the
// harness so on stderr. core-sim writes each wait's length to stderr too, where a
// scenario reads it. So these runs take no wall-clock time, and nothing about time
// reaches a transcript.
//
// Ways it can go wrong, each checked below unless it says otherwise:
//   1. A rate-limited call fails at once, so a large mailbox never finishes its first sync.
//   2. A call Gmail keeps refusing is tried forever.
//   3. The waits do not grow: every try comes a second after the last.
//   4. The waits grow past a minute, the window of the per-user limit.
//   5. Gmail's Retry-After is ignored, always or when it is short.
//   6. A 429 or a userRateLimitExceeded is not waited out.
//   7. A sign-out during a wait leaves the sync waiting, so the core never stops.
//   8. A daily limit is waited out like a rate limit: eight calls for quota a wait does not bring back.
//   9. A change made under a daily limit is refused as not permitted and undone, not kept for later.
//  10. A daily limit is answered as something other than a provider error, so the account shows the wrong state.

import type { GmailFake } from '@letterbox/sim-provider/gmail'
import type { SeedMessage } from '@letterbox/sim-provider/contract'
import {
  ME,
  fromBen,
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

const gmailOf = (t: Scenario): GmailFake => {
  if (!t.gmail) throw new Error('this scenario runs as gmail only')
  return t.gmail
}

/** The adapter's limit on rate-limited answers in a row for one call (RATE_LIMIT_TRIES in api.rs). */
const TRIES = 8

scenario(
  'a gmail mailbox far larger than one minute of quota syncs whole, waiting out each refusal',
  async (t) => {
    const gmail = gmailOf(t)
    const extra = Array.from({ length: 120 }, (_, index): SeedMessage => {
      const sentAt = new Date(Date.UTC(2025, 10, 1, 0, index)).toISOString()
      return fromBen(`note-${index}`, `Note ${index}`, sentAt)
    })
    const seed = standardSeed(t.dialect)
    t.mailbox({ ...seed, messages: [...seed.messages, ...extra] })
    // One metadata get costs 20 units, so a window holds about ten of them and the
    // snapshot of 126 messages needs about thirteen windows.
    gmail.setQuota(ME, { units: 200 })
    const core = t.startCore()
    await core.hello()
    await signIn(t, core, ME, seed.password)
    await sync(core)
    t.note(`Gmail refused ${gmail.refusals(ME)} calls`)
    t.check(gmail.refusals(ME) > TRIES, 'Gmail refused more calls than one call may be refused in a row')
    t.equal((await threads(core)).length, 125, 'every conversation arrived')
    const status = (await core.query({ view: 'accounts' }))[0]?.status.state
    t.equal(status, 'idle', 'the account is idle, not in error')
  },
  ['gmail'],
)

scenario(
  'a gmail call refused again and again ends in a provider error after a fixed number of tries',
  async (t) => {
    const { core, box } = await start(t)
    const gmail = gmailOf(t)
    gmail.setQuota(ME, { units: 0 })
    box.deliver(fromBen('standup', 'Standup moved to 10', '2025-12-05T09:00:00.000Z'))
    const view = core.subscribe({ view: 'accounts' })
    await sync(core)
    const [account] = await untilAccounts(view, (accounts) => accounts[0]?.status.state === 'error')
    t.equal(
      account?.status.state === 'error' && account.status.reason,
      'provider',
      'the account shows a provider error',
    )
    t.equal(gmail.refusals(ME), TRIES, 'the adapter gave up on the first call after its last try')
    t.equal(
      await core.waits(TRIES - 1),
      [1, 2, 4, 8, 16, 32, 60],
      'between tries it waited a second, then twice as long each time, up to a minute',
    )

    gmail.setQuota(ME, null)
    await sync(core)
    t.equal((await threads(core)).length, 6, 'once Gmail answers again the new message arrives')
  },
  ['gmail'],
)

scenario(
  'a gmail rate-limit wait lasts as long as the Retry-After Gmail names',
  async (t) => {
    const { core } = await start(t)
    const gmail = gmailOf(t)
    gmail.setQuota(ME, { units: 0, retryAfter: 30 })
    await sync(core)
    t.equal(gmail.refusals(ME), TRIES, 'the adapter gave up after its last try')
    t.equal(
      await core.waits(TRIES - 1),
      Array.from({ length: TRIES - 1 }, () => 30),
      'every wait was the 30 seconds Gmail named, not the backoff',
    )
  },
  ['gmail'],
)

scenario(
  'a gmail 429 and a userRateLimitExceeded are waited out like a rate limit',
  async (t) => {
    const { core } = await start(t)
    const gmail = gmailOf(t)
    gmail.setQuota(ME, { units: 0, reason: 'userRateLimitExceeded' })
    await sync(core)
    t.equal(gmail.refusals(ME), TRIES, 'the adapter tried a userRateLimitExceeded call as often as a rate limit')
    gmail.setQuota(ME, { units: 0, reason: 'tooManyRequests' })
    await sync(core)
    t.equal(gmail.refusals(ME), 2 * TRIES, 'and a 429 call as often too')
  },
  ['gmail'],
)

scenario(
  'a gmail daily limit ends the sync after one call, and a change made under it waits for more quota',
  async (t) => {
    const { core, box } = await start(t)
    const gmail = gmailOf(t)
    gmail.setQuota(ME, { units: 0, reason: 'dailyLimitExceeded' })
    const view = core.subscribe({ view: 'accounts' })
    await sync(core)
    const [account] = await untilAccounts(view, (accounts) => accounts[0]?.status.state === 'error')
    t.equal(
      account?.status.state === 'error' && account.status.reason,
      'provider',
      'the account shows a provider error',
    )
    t.equal(gmail.refusals(ME), 1, 'the adapter asked once, since a wait does not bring back a daily limit')

    const target = await thread(core, 'Budget numbers')
    const read = await core.command({ kind: 'set-flags', threadIds: [target.id], unread: false })
    await sync(core)
    gmail.setQuota(ME, null)
    await sync(core)
    t.equal((await core.settled(read.change)).result, 'done', 'the change waited for the quota and then went through')
    t.equal(truthOf(box, 'fyi')?.unread, false, 'Gmail has the change')
  },
  ['gmail'],
)

scenario(
  'a gmail sign-out during a rate-limit wait ends the wait, and the sync is answered offline',
  async (t) => {
    const { core, accountId } = await start(t)
    const gmail = gmailOf(t)
    // An hour's Retry-After: core-sim's wait for it holds until the adapter closes.
    gmail.setQuota(ME, { units: 0, retryAfter: 3600 })
    const syncing = core.begin({ method: 'sync-now' })
    await core.waitHeld()
    const signedOut = await core.request({ method: 'sign-out', accountId, deleteLocalMail: false })
    t.check(signedOut.ok, 'the sign-out is answered')
    const answer = await syncing.done
    t.equal(answer.ok === false && answer.error, 'offline', 'the sync waiting on Gmail ends as offline')
    t.equal(gmail.refusals(ME), 1, 'the adapter tried no more calls after the sign-out')
    await core.stop()
    t.note('the core stopped with nothing left waiting')
  },
  ['gmail'],
)
