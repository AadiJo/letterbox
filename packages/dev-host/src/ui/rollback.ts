// The UI check of an archive the provider refuses after the core accepted it. The core puts
// the conversation back in Inbox while its row is still sliding out. The row must come back
// whole, shake once, and take its toast with it. Like first-sync.ts, this check builds the
// dev host's parts in this process, so it can tell the sim provider to refuse.

import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { devSeeds } from '@letterbox/sim-provider/seeds'
import { startSimProvider } from '@letterbox/sim-provider/server'
import type { Browser } from 'playwright'
import { logChildrenTo, stopChildren } from '../children.ts'
import { buildCore, type Paths } from '../core.ts'
import { startServer } from '../server.ts'
import { equal, openPage, root, ROW_HEIGHT } from './record.ts'

const seed = devSeeds['people-first']
const STATE = join(root, '.letterbox/ui-check-rollback')

export async function checkRollback(browser: Browser) {
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
  const mailbox = provider.createMailbox(seed.dialect, seed.seed)
  const server = await startServer({ paths, port: 0, relay: true, sim: { now: seed.now, deliver: () => {} } })
  const opened = await openPage(browser, server.url, 'trace-rollback.zip')
  const { page, relay } = opened
  try {
    await page.waitForFunction(() => window.letterboxDev !== undefined)
    await page.evaluate(([address, password]) => window.letterboxDev?.signIn(address, password), [
      seed.seed.address,
      seed.seed.password,
    ] as const)
    await page
      .getByRole('navigation', { name: 'Sidebar' })
      .getByRole('button', { name: /^Inbox/ })
      .click()
    const rows = page.locator('[data-list="mail"] [role="option"]')
    await rows.first().locator('[data-field="subject"]').waitFor()
    // An unread row, so opening it sends the only other change, and the check waits for it to settle.
    const id = await page
      .locator('[data-list="mail"] [role="option"][data-unread="true"]')
      .first()
      .getAttribute('data-row')
    const row = page.locator(`[data-list="mail"] [data-row="${id}"]`)
    const read = relay.sees('"kind":"settled"')
    await row.click()
    await read

    // The relay holds the core's answer, its update without the row, the refusal and the
    // update that puts the row back, then lets them through together while the row slides.
    mailbox.refuseNextApply('refused-by-provider')
    const paused = relay.pauseAtAccepted()
    const refused = relay.sees('"kind":"settled"')
    await page.keyboard.press('e')
    await paused
    await refused
    const shook = page
      .waitForFunction(
        (selector) =>
          document
            .querySelector(selector)
            ?.getAnimations()
            .some((animation) => animation.effect?.getTiming().duration === 120),
        `[data-list="mail"] [data-row="${id}"]`,
        { timeout: 5000 },
      )
      .then(
        () => true,
        () => false,
      )
    relay.resume()
    equal(await shook, true, 'a refused archive shakes the row the core put back')
    const settled = await row.evaluate(
      (element) =>
        new Promise<{ animations: number; opacity: string; height: number }>((resolve) => {
          // Each frame until no animation is left on the row, then how it looks.
          const look = () => {
            if (element.getAnimations().some((animation) => animation.playState === 'running'))
              return void requestAnimationFrame(look)
            resolve({
              animations: element.getAnimations().length,
              opacity: getComputedStyle(element).opacity,
              height: element.getBoundingClientRect().height,
            })
          }
          look()
        }),
    )
    equal(settled, { animations: 0, opacity: '1', height: ROW_HEIGHT }, 'the row the core put back shows whole')
    equal(await page.getByRole('status').filter({ hasText: 'Archived' }).count(), 0, 'its "Archived" toast goes')
  } finally {
    await opened.close()
    await server.close()
    await provider.close()
    await stopChildren()
  }
}
