// Ways a client can be left without an answer, or with a wrong one.
// Each scenario is one of them.

import { PROTOCOL } from '@letterbox/protocol'
import {
  ME,
  bodiesSettled,
  openThread,
  readThread,
  standardSeed,
  start,
  sync,
  thread,
  threads,
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
  t.mailbox(standardSeed(t.dialect))
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
  t.equal(
    (await core.query({ view: 'accounts' })).map((account) => account.address),
    [ME],
    'one account exists',
  )

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

scenario('a body loads when a conversation is opened, once', async (t) => {
  const { core, box } = await start(t)
  const photos = await thread(core, 'Trip photos')
  const message = (await readThread(core, photos.id))?.messages[0]
  t.check(message?.body.state === 'ready', 'the body arrives')
  if (message?.body.state !== 'ready') return
  t.equal(
    [message.body.text, message.body.hasRemoteContent],
    ['Here are the photos from the trip.', true],
    'it carries the text and flags the remote image',
  )
  t.check(
    message.body.html?.includes('tracker.example') === true,
    'the html is passed on untouched for the UI to sandbox',
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
