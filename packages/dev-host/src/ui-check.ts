// The end-to-end UI check, run by `pnpm check:ui` and `pnpm check`.
//
// Three runs, each against real cores over the sim provider, in Playwright's Chromium:
//   people-first  `pnpm dev` (main.ts) with the people-first seed: People, All mail, the
//                 reader, HTML bodies, the narrow window, keyboard actions, new mail, a reload
//                 (ui/people-first.ts)
//   many          `pnpm dev` with 6,000 conversations: scrolls All mail top to bottom (ui/scroll.ts)
//   first sync    the dev host's parts in this process, with snapshot pages held (ui/first-sync.ts)
// Every process a run started must be gone at its end.
//
// Writes screenshots at 1440×900 and 1024×700 (`<scene>.png`, `<scene>-narrow.png`), a
// Playwright trace per run, scroll.json and summary.json to artifacts/ui/. Open a trace with
//   pnpm --filter @letterbox/dev-host exec playwright show-trace "$PWD/artifacts/ui/trace-people-first.zip"

import { mkdirSync, rmSync } from 'node:fs'
import { type Browser, chromium } from 'playwright'
import { checkFirstSync } from './ui/first-sync.ts'
import { startDevHost } from './ui/host.ts'
import { checkPeopleFirst } from './ui/people-first.ts'
import { ARTIFACTS, fail, failed, summarize } from './ui/record.ts'
import { checkScroll } from './ui/scroll.ts'

rmSync(ARTIFACTS, { recursive: true, force: true })
mkdirSync(ARTIFACTS, { recursive: true })

/** Runs `check` against a fresh `pnpm dev`, then stops the host and checks what it left. `cores` is its page loads. */
async function withDevHost(
  seed: 'people-first' | 'many',
  cores: number,
  browser: Browser,
  check: (browser: Browser, url: string) => Promise<void>,
) {
  const host = startDevHost(seed, `.letterbox/ui-check-${seed}`)
  try {
    await check(browser, await host.url)
  } catch (error) {
    fail(error)
  }
  try {
    await host.stopAndCheck(cores)
  } catch (error) {
    fail(error)
  }
  if (failed()) console.log(`\nDev host stderr (${seed}):\n${host.stderr()}`)
}

const browser = await chromium.launch()
try {
  // The first load and the reload each start a core.
  await withDevHost('people-first', 2, browser, checkPeopleFirst)
  await withDevHost('many', 1, browser, checkScroll)
  await checkFirstSync(browser).catch(fail)
} finally {
  await browser.close()
}

summarize()
process.exitCode = failed() ? 1 : 0
