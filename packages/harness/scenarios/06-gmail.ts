// Ways the Gmail adapter (crates/gmail) can map Gmail wrongly onto the core. Every
// labels scenario in the other files also runs as gmail, which covers sync, bodies,
// archive, trash, flags, offline, expired cursors and restarts. These are the cases
// only Gmail has: OAuth consent, token refresh, revoked grants, the inbox tabs, and
// labels Gmail sets on its own.

import type { GmailFake } from '@letterbox/sim-provider/gmail'
import type { CoreClient } from '../src/client.ts'
import { ME, fromBen, mailbox, signIn, standardSeed, start, sync, thread, threads, truthOf } from '../src/fixtures.ts'
import { type Scenario, scenario } from '../src/scenario.ts'

/** The fake Gmail of a gmail run. Every scenario here is one. */
const gmailOf = (t: Scenario): GmailFake => {
  if (!t.gmail) throw new Error('this scenario runs as gmail only')
  return t.gmail
}

/** Starts a sign-in through the Gmail option and returns its consent URL and its answer. */
async function beginSignIn(core: CoreClient) {
  const option = (await core.query({ view: 'sign-in-options' })).find((candidate) => candidate.label === 'Gmail')
  if (!option) throw new Error('the core lists no Gmail option')
  const attempt = core.begin({ method: 'sign-in', option: option.id })
  const { url } = await core.take('open-url')
  return { url, done: attempt.done }
}

scenario(
  'gmail sign-in sends the user to consent with PKCE and a loopback, and a denial is answered as denied',
  async (t) => {
    const gmail = gmailOf(t)
    t.mailbox(standardSeed(t.dialect))
    const core = t.startCore()
    await core.hello()
    const options = await core.query({ view: 'sign-in-options' })
    t.equal(
      options.map((option) => [option.label, option.method]),
      [['Gmail', 'oauth']],
      'Gmail is offered as an oauth option',
    )

    const denied = await beginSignIn(core)
    const consent = new URL(denied.url).searchParams
    t.equal(
      {
        responseType: consent.get('response_type'),
        redirect: consent.get('redirect_uri'),
        method: consent.get('code_challenge_method'),
        scope: consent.get('scope'),
        challenge: consent.get('code_challenge')?.length,
        state: consent.get('state')?.length,
      },
      {
        responseType: 'code',
        redirect: 'http://127.0.0.1:47000',
        method: 'S256',
        scope: 'https://www.googleapis.com/auth/gmail.modify',
        challenge: 43,
        state: 43,
      },
      'the consent URL asks for a code, with a PKCE challenge, a state and a loopback redirect',
    )
    gmail.denySignIn(denied.url)
    const refusal = await denied.done
    t.equal(refusal.ok === false && refusal.error, 'denied', 'a declined consent is answered as denied')
    t.equal(await core.query({ view: 'accounts' }), [], 'no account was made')

    const approved = await beginSignIn(core)
    t.check(approved.url !== denied.url, 'the second attempt has its own state and challenge')
    gmail.approveSignIn(approved.url, ME)
    t.check((await approved.done).ok, 'an approved consent signs in')
    t.equal(
      (await core.query({ view: 'accounts' })).map((account) => [account.address, account.providerLabel]),
      [[ME, 'Gmail']],
      'the account takes its address from the Gmail profile',
    )
  },
  ['gmail'],
)

scenario(
  'a gmail sign-in still waiting at consent ends when another starts, and its late approval reaches nothing',
  async (t) => {
    const gmail = gmailOf(t)
    t.mailbox(standardSeed(t.dialect))
    const core = t.startCore()
    await core.hello()
    const first = await beginSignIn(core)
    const second = await beginSignIn(core)
    const answer = await first.done
    t.equal(answer.ok === false && answer.error, 'superseded', 'the first attempt is told it was superseded')
    // The first attempt's loopback is closed, so a late approval of it reaches nothing.
    gmail.approveSignIn(first.url, ME)
    gmail.approveSignIn(second.url, ME)
    t.check((await second.done).ok, 'the second attempt signs in')
    t.equal((await core.query({ view: 'accounts' })).length, 1, 'one account exists')
  },
  ['gmail'],
)

scenario(
  'a gmail sign-in while Gmail is unreachable is answered offline',
  async (t) => {
    const box = t.mailbox(standardSeed(t.dialect))
    const core = t.startCore()
    await core.hello()
    box.setOffline(true)
    const attempt = await beginSignIn(core)
    gmailOf(t).approveSignIn(attempt.url, ME)
    const answer = await attempt.done
    t.equal(answer.ok === false && answer.error, 'offline', 'the code exchange found no token endpoint')
  },
  ['gmail'],
)

scenario(
  'gmail labels become mailboxes, and UNREAD and STARRED become flags',
  async (t) => {
    const { core } = await start(t)
    const mailboxes = await core.query({ view: 'mailboxes' })
    t.equal(
      mailboxes.map((each) => [each.name, each.role]),
      [
        ['Inbox', 'inbox'],
        ['Sent', 'sent'],
        ['Trash', 'trash'],
        ['Projects', null],
      ],
      'system labels get readable names and roles; flags, importance and tabs are not mailboxes',
    )
    const photos = await thread(core, 'Trip photos')
    t.equal(
      [photos.flagged, photos.unread, photos.mailboxIds],
      [true, false, []],
      'a starred, read, archived message is flagged, read and in no mailbox',
    )
    t.equal((await mailbox(core, 'Inbox')).unread, 4, 'UNREAD counts toward the inbox unread count')
  },
  ['gmail'],
)

scenario(
  'mail in a gmail promotions tab is bulk, and mail in the personal tab is not',
  async (t) => {
    const { core, box } = await start(t)
    box.deliver(fromBen('sale', 'Weekend sale', '2025-12-05T09:00:00.000Z', { bulk: true }))
    box.deliver(fromBen('question', 'One quick question', '2025-12-05T10:00:00.000Z'))
    await sync(core)
    t.equal(
      (await thread(core, 'Weekend sale')).turn,
      { holder: 'none', reason: 'automated' },
      'a person’s mail that Gmail filed under Promotions is nobody’s turn',
    )
    t.equal(
      (await thread(core, 'One quick question')).turn,
      { holder: 'mine', reason: 'they-wrote-last' },
      'the same kind of mail under Personal is my turn',
    )
  },
  ['gmail'],
)

scenario(
  'trashing a gmail conversation keeps the sent label Gmail set, and flags reach every message',
  async (t) => {
    const { core, box } = await start(t)
    const lunch = await thread(core, 'Lunch on Friday?')
    const flag = await core.command({ kind: 'set-flags', threadIds: [lunch.id], flagged: true })
    t.equal((await core.settled(flag.change)).result, 'done', 'flagging both messages settles as done')
    t.equal(
      [truthOf(box, 'lunch-ask')?.flagged, truthOf(box, 'lunch-answer')?.flagged],
      [true, true],
      'Gmail starred both messages',
    )
    const trash = await core.command({ kind: 'trash', threadIds: [lunch.id] })
    t.equal((await core.settled(trash.change)).result, 'done', 'the trash settles as done')
    t.equal(
      [truthOf(box, 'lunch-ask')?.mailboxes, truthOf(box, 'lunch-answer')?.mailboxes],
      [['trash'], ['sent', 'trash']],
      'the question left the inbox; the answer kept SENT, which only Gmail sets',
    )
    await sync(core)
    const names = new Map((await core.query({ view: 'mailboxes' })).map((each) => [each.id, each.name]))
    t.equal(
      (await thread(core, 'Lunch on Friday?')).mailboxIds.map((id) => names.get(id)).toSorted(),
      ['Sent', 'Trash'],
      'after a sync the conversation shows where Gmail keeps it',
    )
  },
  ['gmail'],
)

scenario(
  'a gmail change still reaches the messages of a conversation that remain after one is deleted',
  async (t) => {
    const { core, box } = await start(t)
    const lunch = await thread(core, 'Lunch on Friday?')
    box.setOffline(true)
    const answer = await core.command({ kind: 'set-flags', threadIds: [lunch.id], unread: true })
    box.expunge('lunch-answer')
    box.setOffline(false)
    await sync(core)
    t.equal((await core.settled(answer.change)).result, 'done', 'the change settles as done')
    t.equal(truthOf(box, 'lunch-ask')?.unread, true, 'the remaining message took it')
  },
  ['gmail'],
)

scenario(
  'an expired gmail access token is refreshed once and the sync goes on',
  async (t) => {
    const { core, box } = await start(t)
    const gmail = gmailOf(t)
    t.equal(gmail.refreshes(ME), 0, 'the sign-in’s own access token was enough so far')
    gmail.expireAccessTokens()
    box.deliver(fromBen('standup', 'Standup moved to 10', '2025-12-05T09:00:00.000Z'))
    await sync(core)
    t.equal(gmail.refreshes(ME), 1, 'one refresh after the first 401')
    t.equal((await threads(core)).length, 6, 'the new message arrived')
    const status = (await core.query({ view: 'accounts' }))[0]?.status.state
    t.equal(status, 'idle', 'the account never left idle')
  },
  ['gmail'],
)

scenario(
  'a restarted core reaches gmail with the refresh token from its session',
  async (t) => {
    const first = await start(t)
    await first.core.stop()
    first.box.deliver(fromBen('standup', 'Standup moved to 10', '2025-12-05T09:00:00.000Z'))
    const before = first.box.calls()
    const core = t.startCore()
    await core.hello()
    await sync(core)
    t.equal(gmailOf(t).refreshes(ME), 1, 'the restarted adapter refreshed once, having no access token')
    const after = first.box.calls()
    t.equal(
      [after.snapshot - before.snapshot, after.changes - before.changes],
      [0, 1],
      'it resumed from the stored history id',
    )
    t.equal((await threads(core)).length, 6, 'the message that arrived while the core was down shows up')
  },
  ['gmail'],
)

scenario(
  'a revoked gmail grant asks for a new sign-in, and signing in again picks up',
  async (t) => {
    const { core, box } = await start(t)
    const gmail = gmailOf(t)
    gmail.revokeAccess(ME)
    box.deliver(fromBen('standup', 'Standup moved to 10', '2025-12-05T09:00:00.000Z'))
    await core.request({ method: 'sync-now' })
    const account = (await core.query({ view: 'accounts' }))[0]
    t.equal(account?.status.state, 'needs-sign-in', 'the account waits for a new sign-in')
    t.equal((await threads(core)).length, 5, 'the mail read before stays')

    await signIn(t, core, ME, '')
    await sync(core)
    t.equal((await threads(core)).length, 6, 'after a new sign-in the new message arrives')
    const review = await thread(core, 'Can you review the draft?')
    const read = await core.command({ kind: 'set-flags', threadIds: [review.id], unread: false })
    t.equal((await core.settled(read.change)).result, 'done', 'changes reach Gmail again')
    t.equal(truthOf(box, 'review')?.unread, false, 'Gmail holds it as read')
  },
  ['gmail'],
)
