// Gmail's per-user rate limit. The fake refuses calls over a scenario's budget with the
// 403 rateLimitExceeded a live run got, and the adapter must wait and try the same call
// again (crates/gmail/src/api.rs). core-sim's waits return at once, except a wait for a
// Retry-After of an hour or more, which holds until the adapter closes and tells the
// harness so on stderr. So these runs take no wall-clock time, and nothing about time
// reaches a transcript.

import type { GmailFake } from '@letterbox/sim-provider/gmail'
import type { SeedMessage } from '@letterbox/sim-provider/contract'
import { ME, fromBen, signIn, standardSeed, start, sync, threads, untilAccounts } from '../src/fixtures.ts'
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

    gmail.setQuota(ME, null)
    await sync(core)
    t.equal((await threads(core)).length, 6, 'once Gmail answers again the new message arrives')
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
