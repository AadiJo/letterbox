// Every Gmail request has a time budget (`Timeouts` in crates/gmail/src/config.rs), so an answer
// that stalls cannot hold the account's queue, and with it every sync, send and change, for good.
// Each scenario gives core-sim budgets of a few seconds (SHORT), so a stalled call fails inside
// the harness's 5 s wait, and the fake stalls the next answer halfway through its body
// (`stallNextAnswer`). The transfer budget is longer than that wait, so a stalled download ends
// inside it only by the stall budget.
//
// Ways it can go wrong: no deadline, so the call hangs; a deadline read as Gmail's own error; an
// error answer whose reason never came read as a refusal, though the call may have landed; a
// download that stopped moving held for the whole transfer budget; and a send whose upload is
// slow ended by the stall budget, which is only for downloads.

import type { Attachment } from '@letterbox/protocol'
import type { Scenario } from '../src/scenario.ts'
import { fromBen, ME, openWithBody, sync, thread, untilAccounts } from '../src/fixtures.ts'
import { draft, startWith } from '../src/sending.ts'
import { scenario } from '../src/scenario.ts'

/** Seconds for the call, transfer and stall budgets (`gmailTimeouts` in scenario.ts). */
const SHORT: [number, number, number] = [3, 60, 3]

/** The usual start, with SHORT budgets. */
const startShort = (t: Scenario) => startWith(t, { gmailTimeouts: SHORT })

/** The fake Gmail of a gmail run. These scenarios run only as gmail. */
const gmailOf = (t: Scenario) => {
  if (!t.gmail) throw new Error('this scenario runs as gmail only')
  return t.gmail
}

scenario(
  'on gmail, a call whose answer stalls fails as offline once its time is up, and the next sync goes through',
  async (t) => {
    const gmail = gmailOf(t)
    const { core, box } = await startShort(t)
    box.deliver(fromBen('fresh', 'Fresh news', '2025-12-09T09:00:00.000Z'))
    const accounts = core.subscribe({ view: 'accounts' })
    gmail.stallNextAnswer()
    const stalled = await core.request({ method: 'sync-now' })
    t.equal(stalled.ok ? null : stalled.error, 'offline', 'the sync gives up on the stalled call and says offline')
    await untilAccounts(accounts, (list) => list[0]?.status.state === 'offline')
    t.check((await core.request({ method: 'sync-now' })).ok, 'the next sync goes through')
    t.check((await thread(core, 'Fresh news')).subject === 'Fresh news', 'and brings the new mail')
  },
  ['gmail'],
)

scenario(
  'on gmail, an answer that trickles forever ends at the call budget, though bytes keep coming',
  async (t) => {
    const gmail = gmailOf(t)
    const { core } = await startShort(t)
    gmail.stallNextAnswer(undefined, true)
    const trickled = await core.request({ method: 'sync-now' })
    t.equal(trickled.ok ? null : trickled.error, 'offline', 'the sync gives up once the call budget runs out')
    t.check((await core.request({ method: 'sync-now' })).ok, 'the next sync goes through')
  },
  ['gmail'],
)

scenario(
  'on gmail, a send whose refusal stalls before its reason is not taken as refused',
  async (t) => {
    const gmail = gmailOf(t)
    // A send has the transfer budget and no stall budget, so its transfer budget is short here.
    const { core, accountId } = await startWith(t, { gmailTimeouts: [3, 3, 3] })
    // A new message, so the send is its first call: a reply looks its thread up first.
    const message = draft(accountId, null, { subject: 'New message' })
    // The rate limit refuses the send, and its answer stalls before the reason that says so.
    gmail.setQuota(ME, { units: 0, reason: 'userRateLimitExceeded' })
    gmail.stallNextAnswer('messages/send')
    const send = await core.command({ kind: 'send', draft: message })
    await gmail.answerStalled()
    gmail.setQuota(ME, null)
    t.equal(
      (await core.settled(send.change)).result,
      { failed: 'unconfirmed' },
      'the send may have landed, so it is looked up, and with no copy found it fails as unconfirmed, not refused',
    )
  },
  ['gmail'],
)

scenario(
  'on gmail, a change whose refusal stalls before its reason is not taken as refused',
  async (t) => {
    const gmail = gmailOf(t)
    const { core, box } = await startShort(t)
    const target = await thread(core, 'Can you review the draft?')
    gmail.setQuota(ME, { units: 0, reason: 'userRateLimitExceeded' })
    gmail.stallNextAnswer('/modify')
    const change = await core.command({ kind: 'set-flags', threadIds: [target.id], unread: false })
    await gmail.answerStalled()
    gmail.setQuota(ME, null)
    // The core cannot tell whether the change landed, so it waits for a pull to show it. Gmail
    // refused it, so the pull shows it did not, and the change fails as unconfirmed, not refused.
    await sync(core)
    t.equal(
      (await core.settled(change.change)).result,
      { failed: 'unconfirmed' },
      'the change settles as unconfirmed once a sync shows Gmail',
    )
    t.equal(box.truth().find((message) => message.key === 'review')?.unread, true, 'Gmail never took it')
  },
  ['gmail'],
)

scenario(
  'on gmail, a download that stops moving gives up long before its transfer budget, and the queue moves on',
  async (t) => {
    const gmail = gmailOf(t)
    const { core, box } = await startShort(t)
    box.deliver(
      fromBen('contract', 'The signed contract', '2025-12-05T09:00:00.000Z', {
        attachments: [{ name: 'contract.pdf', mime: 'application/pdf', size: 3000 }],
      }),
    )
    await sync(core)
    const opened = await openWithBody(core, (await thread(core, 'The signed contract')).id)
    const [file] = opened.attachments as [Attachment]
    gmail.stallNextAnswer('/attachments/')
    const fetched = await core.request({ method: 'attachment', blobId: file.blobId })
    t.equal(fetched.ok ? null : fetched.error, 'offline', 'the download gives up once no byte has come for a while')
    t.check((await core.request({ method: 'sync-now' })).ok, 'and a sync queued after it goes through')
  },
  ['gmail'],
)

scenario(
  'on gmail, a send whose upload is slow past the stall budget still goes out within its transfer budget',
  async (t) => {
    const gmail = gmailOf(t)
    // A stall budget of a second, and the send not read for two: only a download may be ended by it.
    const { core, box, accountId } = await startWith(t, { gmailTimeouts: [3, 60, 1] })
    gmail.slowNextRequest('messages/send', 2)
    const send = await core.command({ kind: 'send', draft: draft(accountId, null, { subject: 'New message' }) })
    t.equal((await core.settled(send.change)).result, 'done', 'the send goes out')
    t.equal(box.sent().length, 1, 'once')
  },
  ['gmail'],
)
