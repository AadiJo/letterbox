// Ways a client can be left without an answer, or with a wrong one.
// Each scenario is one of them.

import { PROTOCOL } from '@letterbox/protocol'
import {
  ME,
  PASSWORD,
  bodiesSettled,
  openThread,
  readThread,
  signIn,
  standardSeed,
  start,
  sync,
  thread,
  threads,
  watchThread,
} from '../src/fixtures.ts'
import { scenario } from '../src/scenario.ts'

scenario('the core greets a client and refuses a different protocol version', async (t) => {
  const core = t.startCore()
  const welcome = await core.hello()
  t.equal(welcome.protocol, PROTOCOL, 'welcome carries the protocol version')
  core.sendRaw({ kind: 'hello', protocol: PROTOCOL + 1 })
  t.equal((await core.take('protocol-error')).reason, 'version-mismatch', 'another version is refused')
})

scenario('input the core cannot read is answered and does not stop it', async (t) => {
  const core = t.startCore()
  await core.hello()
  core.sendRaw('this is not json')
  t.equal((await core.take('protocol-error')).reason, 'malformed', 'text that is not JSON is answered')
  core.sendRaw({ kind: 'subscribe', sub: 'sub_x', query: { view: 'thread' } })
  t.equal((await core.take('protocol-error')).reason, 'malformed', 'a query missing a field is answered')
  t.equal(await core.query({ view: 'accounts' }), [], 'the core still answers afterwards')
})

scenario('a wrong password ends the sign-in with an answer and no account', async (t) => {
  t.mailbox(standardSeed(t.dialect))
  const core = t.startCore()
  await core.hello()
  const options = await core.query({ view: 'sign-in-options' })
  const option = options.find((candidate) => candidate.method === 'password')
  t.check(option !== undefined, 'the core lists a password option')
  if (!option) return
  const response = await core.request({
    method: 'sign-in',
    option: option.id,
    password: { username: ME, password: 'wrong' },
  })
  t.equal(response.ok === false && response.error, 'wrong-password', 'the answer says why')
  t.equal(await core.query({ view: 'accounts' }), [], 'no account was made')
})

scenario('a second sign-in ends the first one, and each gets its own answer', async (t) => {
  const box = t.mailbox(standardSeed(t.dialect))
  // The first sync waits at its first page until the accounts are checked. Unheld, it could
  // write before or after the check, and the transcript would change from run to run.
  box.holdSnapshots()
  const core = t.startCore()
  await core.hello()
  const option = (await core.query({ view: 'sign-in-options' })).find((candidate) => candidate.method === 'oauth')
  t.check(option !== undefined, 'the core lists an oauth option')
  if (!option) return

  const first = core.begin({ method: 'sign-in', option: option.id })
  const firstUrl = await core.take('open-url')
  const second = core.begin({ method: 'sign-in', option: option.id })
  const firstAnswer = await first.done
  t.equal(firstAnswer.ok === false && firstAnswer.error, 'superseded', 'the first attempt is told it was superseded')
  const secondUrl = await core.take('open-url')
  t.equal([firstUrl.id, secondUrl.id], [first.id, second.id], 'each url names the request it belongs to')
  t.provider.approveSignIn(secondUrl.url, ME)
  const secondAnswer = await second.done
  t.check(secondAnswer.ok, 'the second attempt signs in')
  await box.snapshotHeld()
  t.equal(
    (await core.query({ view: 'accounts' })).map((account) => account.address),
    [ME],
    'one account exists',
  )
  box.releaseSnapshots()

  const third = core.begin({ method: 'sign-in', option: option.id })
  t.provider.denySignIn((await core.take('open-url')).url)
  const thirdAnswer = await third.done
  t.equal(thirdAnswer.ok === false && thirdAnswer.error, 'denied', 'a refused consent is answered as denied')
})

scenario('a sign-in still waiting for the user is answered cancelled when the core stops', async (t) => {
  t.mailbox(standardSeed(t.dialect))
  const core = t.startCore()
  await core.hello()
  const option = (await core.query({ view: 'sign-in-options' })).find((candidate) => candidate.method === 'oauth')
  t.check(option !== undefined, 'the core lists an oauth option')
  if (!option) return
  const attempt = core.begin({ method: 'sign-in', option: option.id })
  await core.take('open-url')
  const stopped = core.stop()
  const answer = await attempt.done
  t.equal(answer.ok === false && answer.error, 'cancelled', 'the waiting sign-in is told it was cancelled')
  await stopped
})

scenario('a sign-out is answered while a provider call is still in flight', async (t) => {
  const { core, box, accountId } = await start(t)
  const photos = await thread(core, 'Trip photos')
  box.holdBodies()
  const open = watchThread(core, photos.id)
  t.equal((await open.next())?.messages[0]?.body.state, 'loading', 'the body is loading while the provider holds it')
  const signedOut = await core.request({ method: 'sign-out', accountId, deleteLocalMail: false })
  t.check(signedOut.ok, 'the sign-out does not wait for the provider to answer')
  box.releaseBodies()
  // The released body is kept with the mail the sign-out kept. Waiting for it fixes the revision of the next answer.
  while (open.latest()?.messages[0]?.body.state !== 'ready') await open.next()
  const account = (await core.query({ view: 'accounts' }))[0]
  t.equal(account?.status.state, 'needs-sign-in', 'the account waits for a new sign-in')
})

scenario(
  'a sign-out that deletes mail settles waiting changes, and a push in flight cannot bring them back',
  async (t) => {
    const { core, box, accountId } = await start(t)
    const target = await thread(core, 'Can you review the draft?')
    box.holdApplies()
    const answer = await core.command({ kind: 'set-flags', threadIds: [target.id], unread: false })
    await box.applyHeld()
    const signedOut = await core.request({ method: 'sign-out', accountId, deleteLocalMail: true })
    t.check(signedOut.ok, 'the sign-out is answered while the push waits at the provider')
    t.equal(
      (await core.settled(answer.change)).result,
      { failed: 'unknown-target' },
      'the waiting change settles as failed',
    )
    box.releaseApplies()
    // Stopping waits for the push to finish, so whatever it wrote is in the store the next core reads.
    await core.stop()
    const again = t.startCore()
    await again.hello()
    t.equal(await again.query({ view: 'accounts' }), [], 'no account came back')
    t.equal(await threads(again), [], 'no mail came back')
  },
)

scenario('a sign-out that keeps mail stays signed out while a push in flight finishes', async (t) => {
  const { core, box, accountId } = await start(t)
  const target = await thread(core, 'Can you review the draft?')
  box.holdApplies()
  const answer = await core.command({ kind: 'set-flags', threadIds: [target.id], unread: false })
  await box.applyHeld()
  await core.request({ method: 'sign-out', accountId, deleteLocalMail: false })
  box.releaseApplies()
  await core.stop()
  const again = t.startCore()
  await again.hello()
  const account = (await again.query({ view: 'accounts' }))[0]
  t.equal(account?.status.state, 'needs-sign-in', 'the account still waits for a sign-in')
  t.check((await thread(again, 'Can you review the draft?')).pending, 'the change still waits to reach the provider')
  await signIn(t, again, ME, PASSWORD)
  t.equal((await again.settled(answer.change)).result, 'done', 'it settles once the account is signed in again')
})

scenario('a body loads when a conversation is opened, once', async (t) => {
  const { core, box } = await start(t)
  const photos = await thread(core, 'Trip photos')
  const message = (await readThread(core, photos.id))?.messages[0]
  t.check(message?.body.state === 'ready', 'the body arrives')
  if (message?.body.state !== 'ready') return
  t.equal(
    [message.body.text, message.body.images],
    [
      'Here are the photos from the trip.',
      { shown: 'blocked', remote: [], trackers: [{ host: 'tracker.example', reason: 'beacon' }] },
    ],
    'it carries the text, and its one remote image is a tracking pixel the core took out',
  )
  t.equal(
    message.body.html,
    '<p>Here are the photos.</p>',
    'the html, still for the UI to sandbox, has no tracker in it',
  )
  t.equal(
    message.attachments.map((attachment) => attachment.name),
    ['file-1.bin', 'file-2.bin'],
    'it lists the attachments',
  )

  const again = await readThread(core, photos.id)
  t.equal(again?.messages[0]?.body.state, 'ready', 'opening it again is served from the store')
  t.equal(box.calls().body, 1, 'the provider was asked for the body once')
})

scenario('a body that cannot load offline says so and loads after the next sync', async (t) => {
  const { core, box } = await start(t)
  const photos = await thread(core, 'Trip photos')
  box.setOffline(true)
  const open = await openThread(core, photos.id)
  t.equal(
    open.latest()?.messages[0]?.body,
    { state: 'unavailable', reason: 'offline' },
    'the body says it is unavailable offline',
  )
  box.setOffline(false)
  await sync(core)
  t.equal((await bodiesSettled(open))?.messages[0]?.body.state, 'ready', 'it loads once the provider is reachable')
})

scenario('an account whose provider is unreachable says it is offline', async (t) => {
  const { core, box } = await start(t)
  box.setOffline(true)
  const response = await core.request({ method: 'sync-now' })
  t.equal(response.ok === false && response.error, 'offline', 'the sync answer says offline')
  const account = (await core.query({ view: 'accounts' }))[0]
  t.equal(account?.status.state, 'offline', 'the account status says offline')
  t.check(
    account?.status.state === 'offline' && account.status.lastSyncedAt !== null,
    'it still says when it last synced',
  )
  t.equal((await threads(core)).length, 5, 'the mail read before stays available')
})
