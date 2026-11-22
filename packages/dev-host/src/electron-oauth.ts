// The oauth run of the Electron check (electron-check.ts): the sign-in `pnpm dev:desktop
// --core gmail` makes, against the fake Gmail (packages/sim-provider/src/gmail) instead of
// Google. The app's main runs core-sim with only the fake Gmail's sign-in option, over an empty
// store, and the Vite renderer loads with `?sign-in=oauth`, as the dev host loads it:
//   - the page starts the core's OAuth option itself (apps/desktop/renderer/src/dev.ts);
//   - main, not the page, opens the consent page, through shell.openExternal, which is
//     stubbed so nothing reaches the desktop's browser;
//   - the fake approves that consent and redirects to the core's loopback, and the sign-in
//     answers ok, with the session in core-sim's stand-in keychain;
//   - a second launch over the same store resumes the account from that keychain, and the
//     page starts no sign-in and main opens nothing.
// Each launch first loads the page without the parameter, waits until that page's core
// answers, puts the stub in main, then adds the parameter and reloads, so no sign-in can start
// before the stub is there. Main starts a core before any page asks, and a reload that comes
// before the first page has taken it gets that core instead, so the wait is what makes it one
// core per page load. The first page
// never starts a sign-in, even when its dev hooks load after the URL changed: they read the
// URL the page loaded from (apps/desktop/renderer/src/dev.ts).
// Not on Windows: core-sim's fake Gmail redirects over unix sockets (crates/sim-client).

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startFakeGmail } from '@letterbox/sim-provider/gmail'
import type { Page } from 'playwright'
import type { DevServer } from './server.ts'
import { shellEnv } from './desktop.ts'
import { checkQuit, equal, type Launched, paths, quit, seed, STATE, WAIT_MS, withApp, within } from './electron-app.ts'

/** What main's stubbed shell.openExternal was asked to open, kept on main's globalThis. */
type OpenedUrls = { urls: string[]; first: Promise<string> }

declare global {
  var letterboxOpened: OpenedUrls | undefined
}

/** The store of this run. Beside the sim's, so main's log stays in the same user data folder. */
const DATA = join(STATE, 'oauth-data')
/** core-sim's stand-in keychain in that store (KEYCHAIN_FILE in crates/sim-client/src/main.rs). */
const KEYCHAIN = join(DATA, 'sim-keychain.json')

/** Stubs main's shell.openExternal, then reloads the page with `?sign-in=oauth`. Resolves with what the page's sign-in came to. */
async function signInFromPage(run: Launched) {
  await run.page.waitForFunction(() => window.letterboxDev !== undefined, null, { timeout: WAIT_MS })
  await within(
    run.page.evaluate(() => window.letterboxDev?.settle()),
    "the first page's core answering",
  )
  await run.app.evaluate(({ shell }) => {
    const urls: string[] = []
    const first = new Promise<string>((resolve) => {
      shell.openExternal = async (url: string) => {
        urls.push(url)
        resolve(url)
      }
    })
    globalThis.letterboxOpened = { urls, first }
  })
  // A reload asks for the URL the page is on, which main lets through (lockNavigation).
  await run.page.evaluate(() => history.replaceState(null, '', '?sign-in=oauth'))
  await run.page.reload()
  await run.page.waitForFunction(() => window.letterboxDev?.oauth !== undefined, null, { timeout: WAIT_MS })
  return (page: Page) =>
    within(
      page.evaluate(() => window.letterboxDev?.oauth),
      "the page's sign-in",
    )
}

/** The URLs main has asked the OS to open so far. */
const opened = (run: Launched) => run.app.evaluate(() => globalThis.letterboxOpened?.urls ?? [])

export async function oauthRun(server: DevServer) {
  if (process.platform === 'win32') return console.log('skip oauth: the fake Gmail redirects over unix sockets')
  rmSync(DATA, { recursive: true, force: true })
  // A short folder: a unix socket path must fit in 104 bytes on macOS.
  const redirects = mkdtempSync(join(tmpdir(), 'lb-oauth-'))
  const fake = await startFakeGmail(redirects)
  const address = seed.seed.address
  fake.createMailbox(seed.seed)
  const env = shellEnv({ ...paths, data: DATA }, server.url, {
    kind: 'fake-gmail',
    now: seed.now,
    url: fake.url,
    redirects,
  })
  try {
    await withApp(
      'oauth',
      server.url,
      async (run) => {
        const answer = await signInFromPage(run)
        const consent = await within(
          run.app.evaluate(() => globalThis.letterboxOpened?.first),
          'main opening the consent page',
        )
        equal(
          consent?.startsWith('https://consent.fake.test/o/oauth2/v2/auth?'),
          true,
          "oauth: with no account, the page starts the core's OAuth option, and main opens its consent page",
        )
        if (consent !== undefined) fake.approveSignIn(consent, address)
        equal(await answer(run.page), { kind: 'signed-in' }, 'oauth: once the fake approves, the sign-in answers ok')
        equal((await opened(run)).length, 1, 'oauth: main opened one page, the consent')
        checkQuit('oauth', run, await quit(run), 2)
        const sessions: unknown = JSON.parse(readFileSync(KEYCHAIN, 'utf8'))
        equal(
          typeof sessions === 'object' && sessions !== null ? Object.keys(sessions).length : 0,
          1,
          "oauth: the session is in the core's keychain",
        )
      },
      [],
      env,
    )
    await withApp(
      'oauth-resume',
      server.url,
      async (run) => {
        const answer = await signInFromPage(run)
        equal(
          await answer(run.page),
          { kind: 'already-signed-in' },
          'oauth-resume: after a restart the account resumes from the keychain, so the page starts no sign-in',
        )
        equal(await opened(run), [], 'oauth-resume: main opens nothing')
        checkQuit('oauth-resume', run, await quit(run), 2)
      },
      [],
      env,
    )
  } finally {
    await fake.close()
    rmSync(redirects, { recursive: true, force: true })
  }
}
