// Where the core keeps each account's session: in the secret store the host gives it,
// never in its own store. core-sim's stand-in keychain is a file the scenario can read
// and lock. The runner checks every run's store files for sessions on its own.

import { ME, PASSWORD, signIn, standardSeed, start, sync } from '../src/fixtures.ts'
import { scenario } from '../src/scenario.ts'

scenario('a session stays in the keychain until a sign-out deletes it', async (t) => {
  const first = await start(t)
  t.equal(t.keychain(), [first.accountId], 'the sign-in saved one session, under the account id')
  await first.core.stop()

  const core = t.startCore()
  await core.hello()
  await sync(core)
  t.note('the account resumed from the saved session')
  const kept = await core.request({ method: 'sign-out', accountId: first.accountId, deleteLocalMail: false })
  t.check(kept.ok, 'the sign-out that keeps mail is answered')
  t.equal(t.keychain(), [], 'the sign-out deleted the session')
  await core.stop()

  const again = t.startCore()
  await again.hello()
  const account = (await again.query({ view: 'accounts' }))[0]
  t.equal(account?.status.state, 'needs-sign-in', 'after a restart the account still waits for a sign-in')
  const relinked = await signIn(t, again, ME, PASSWORD)
  t.equal(relinked, first.accountId, 'signing in again links the same account')
  t.equal(t.keychain(), [first.accountId], 'and saves its session again')
  const deleted = await again.request({ method: 'sign-out', accountId: relinked, deleteLocalMail: true })
  t.check(deleted.ok, 'the sign-out that deletes mail is answered')
  t.equal(t.keychain(), [], 'it deleted the session too')
})

scenario('a locked keychain fails the sign-in, and at start leaves the account waiting for one', async (t) => {
  t.mailbox(standardSeed(t.dialect))
  const core = t.startCore()
  await core.hello()
  const option = (await core.query({ view: 'sign-in-options' })).find((candidate) => candidate.method === 'password')
  t.check(option !== undefined, 'the core lists a password option')
  if (!option) return
  t.lockKeychain(true)
  const refused = await core.request({
    method: 'sign-in',
    option: option.id,
    password: { username: ME, password: PASSWORD },
  })
  t.equal(refused.ok === false && refused.error, 'keychain', 'the answer says the keychain would not save the login')
  t.equal(await core.query({ view: 'accounts' }), [], 'no account was made')
  t.lockKeychain(false)
  const accountId = await signIn(t, core, ME, PASSWORD)
  await sync(core)
  await core.stop()

  t.lockKeychain(true)
  const locked = t.startCore()
  await locked.hello()
  const waiting = (await locked.query({ view: 'accounts' }))[0]
  t.equal(waiting?.status.state, 'needs-sign-in', 'an account whose session cannot be read waits for a sign-in')
  await locked.stop()

  t.lockKeychain(false)
  const unlocked = t.startCore()
  await unlocked.hello()
  await sync(unlocked)
  const back = (await unlocked.query({ view: 'accounts' }))[0]
  t.equal([back?.id, back?.status.state], [accountId, 'idle'], 'once the keychain opens, the account resumes')
})
