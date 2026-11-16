// The UI check of a first sync, stopped at known pages. main.ts signs in and syncs before
// the page opens, so this check builds the same pieces itself: the sim provider in this
// process with its snapshot pages held, and server.ts over an empty store. The page signs
// in through its own core, and the check lets one snapshot page through at a time.

import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { devSeeds } from '@letterbox/sim-provider/seeds'
import { startSimProvider } from '@letterbox/sim-provider/server'
import type { Browser, Page } from 'playwright'
import { logChildrenTo, stopChildren } from '../children.ts'
import { buildCore, type Paths } from '../core.ts'
import { startServer } from '../server.ts'
import { capture, equal, openPage, root } from './record.ts'

const seed = devSeeds['people-first']
/** Small pages, so the first one holds a few people and most of the mailbox is still to come. */
const PAGE_SIZE = 40
const STATE = join(root, '.letterbox/ui-check-sync')

const syncCount = (page: Page) => page.locator('[data-field="sync-count"]').textContent()

export async function checkFirstSync(browser: Browser) {
  rmSync(STATE, { recursive: true, force: true })
  const paths: Paths = {
    root,
    data: join(STATE, 'data'),
    socket: join(STATE, 'provider.sock'),
    coreLog: join(STATE, 'core.log'),
  }
  mkdirSync(paths.data, { recursive: true })
  logChildrenTo(join(STATE, 'host.log'))

  await buildCore(paths)
  const provider = await startSimProvider(paths.socket)
  const mailbox = provider.createMailbox(seed.dialect, { ...seed.seed, pageSize: PAGE_SIZE })
  mailbox.holdSnapshots()
  const server = await startServer({ paths, port: 0, relay: true, sim: { now: seed.now, deliver: () => {} } })
  const opened = await openPage(browser, server.url, 'trace-first-sync.zip')
  const { page } = opened
  try {
    await page.waitForFunction(() => window.letterboxDev !== undefined)
    // Not awaited: the sign-in may wait on the snapshot this check holds.
    await page.evaluate(([address, password]) => void window.letterboxDev?.signIn(address, password), [
      seed.seed.address,
      seed.seed.password,
    ] as const)

    // Before the first page: syncing, nothing listed, and no labels yet.
    await mailbox.snapshotHeld()
    await page.getByRole('status', { name: 'Sync' }).waitFor()
    equal(await syncCount(page), '0 messages so far', 'first sync: the strip shows nothing listed yet')
    equal(
      await page.getByText('Arriving as older mail syncs').isVisible(),
      true,
      'first sync: Labels says they arrive as older mail syncs',
    )

    // One page through. The core asks for the next, which waits, so the account stays syncing.
    mailbox.releaseSnapshots()
    mailbox.holdSnapshots()
    await mailbox.snapshotHeld()
    await page.waitForFunction(
      (size) => document.querySelector('[data-field="sync-count"]')?.textContent === `${size} messages so far`,
      PAGE_SIZE,
    )
    // The body waits behind the held page, so the reader says it is loading.
    await page.locator('[role="listbox"][aria-label="Your turn"] [role="option"]').first().click()
    await page.locator('[data-message="open"]').waitFor()
    equal(await syncCount(page), `${PAGE_SIZE} messages so far`, 'first sync: the strip counts the first page')
    await capture(page, 'first-sync')

    // The rest of the pages. The strip goes once the snapshot ends, and the body arrives.
    mailbox.releaseSnapshots()
    await page.getByRole('status', { name: 'Sync' }).waitFor({ state: 'detached', timeout: 60_000 })
    equal(await page.getByRole('status', { name: 'Sync' }).count(), 0, 'first sync: the strip goes when the sync ends')
    await page.locator('[data-message="open"] [data-field="body"]').waitFor()
    equal(await page.getByText('Arriving as older mail syncs').count(), 0, 'first sync: the labels note goes')
  } finally {
    mailbox.releaseSnapshots()
    await opened.close()
    await server.close()
    await provider.close()
    await stopChildren()
  }
}
