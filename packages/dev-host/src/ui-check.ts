// The end-to-end UI check, run by `pnpm check:ui` and `pnpm check`.
//
// Eleven runs, each against real cores over the sim provider, in Playwright's Chromium:
//   people-first  `pnpm dev` (main.ts) with the people-first seed: People, All mail, the
//                 reader, the C2 design's rules (ui/c2.ts), HTML bodies, the narrow window,
//                 keyboard actions, new mail, a reload (ui/people-first.ts)
//   done          `pnpm dev` with the people-first seed again: the reading column at 1920 px, Done
//                 and its undo, archive and Trash, a late answer and a scroll during an exit,
//                 an empty Your turn, reduced motion (ui/done.ts)
//   updates       `pnpm dev` with the updates seed: Updates and its volume, an opened sender, Mark
//                 read and Archive all and their undo, Let go? by month, Let go and its toast (ui/updates.ts)
//   many          `pnpm dev` with 6,000 conversations: scrolls All mail top to bottom (ui/scroll.ts)
//   first sync    the dev host's parts in this process, with snapshot pages held (ui/first-sync.ts)
//   rollback      the same parts, with an archive the provider refuses (ui/rollback.ts)
//   reply         the same parts: the docked reply editor, sending, undo, a refused send and a lost answer (ui/reply.ts)
//   compose       the same parts: the compose page, a new message and a forward, recipient
//                 suggestions, sending and undo from it (ui/compose.ts, ui/forward.ts)
//   lost core     the same parts: the strip at the reader's foot once the connection drops, and Reload (ui/lost-core.ts)
//   attachments   the same parts: a message's files as rows, and each state of a save or an open (ui/attachments.ts)
//   body          the same parts with the fake web: remote images shown and blocked, and quoted history folded (ui/body.ts)
//   colors        the same parts: HTML mail dark and in its sender's colors, the switch, its reach and the prefix (ui/body-colors.ts)
// Every process a run started must be gone at its end.
//
// Writes screenshots at 1440×900, 1920×1080 and 1024×700 (`<scene>.png`, `<scene>-1920.png`,
// `<scene>-narrow.png`), the C2 screens at twice their pixels to compare with the mocks
// (`c2-<screen>.png`), a
// Playwright trace per run (a failed run's too), scroll.json and summary.json to artifacts/ui/. Open a trace with
//   pnpm --filter @letterbox/dev-host exec playwright show-trace "$PWD/artifacts/ui/trace-people-first.zip"

import { mkdirSync, rmSync } from 'node:fs'
import { type Browser, chromium } from 'playwright'
import { checkAttachments } from './ui/attachments.ts'
import { checkColors } from './ui/body-colors.ts'
import { checkBody } from './ui/body.ts'
import { checkCompose } from './ui/compose.ts'
import { checkDone } from './ui/done.ts'
import { checkFirstSync } from './ui/first-sync.ts'
import { checkLostCore } from './ui/lost-core.ts'
import { startDevHost } from './ui/host.ts'
import { checkPeopleFirst } from './ui/people-first.ts'
import { checkReply } from './ui/reply.ts'
import { checkRollback } from './ui/rollback.ts'
import { ARTIFACTS, closeLeftOpen, fail, failed, summarize } from './ui/record.ts'
import { checkScroll } from './ui/scroll.ts'
import { checkUpdatesScreens } from './ui/updates.ts'

rmSync(ARTIFACTS, { recursive: true, force: true })
mkdirSync(ARTIFACTS, { recursive: true })

/** Runs one check and records its failure. A page it left open by failing part way still saves its trace. */
async function runCheck(check: () => Promise<void>) {
  await check().catch(fail)
  await closeLeftOpen()
}

/** Runs `check` against a fresh `pnpm dev` with `seed`, then stops the host and checks what it left. `cores` is its page loads. */
async function withDevHost(
  run: string,
  seed: 'people-first' | 'updates' | 'many',
  cores: number,
  browser: Browser,
  check: (browser: Browser, url: string) => Promise<void>,
) {
  const host = startDevHost(run, seed)
  await runCheck(async () => check(browser, await host.url))
  try {
    await host.stopAndCheck(cores)
  } catch (error) {
    fail(error)
  }
  if (failed()) console.log(`\nDev host stderr (${run}):\n${host.stderr()}`)
}

const browser = await chromium.launch()
try {
  // The first load and the reload each start a core.
  await withDevHost('people-first', 'people-first', 2, browser, checkPeopleFirst)
  // The undo checks end the connection three times, and reload each time to connect again.
  await withDevHost('done', 'people-first', 4, browser, checkDone)
  await withDevHost('updates', 'updates', 1, browser, checkUpdatesScreens)
  await withDevHost('many', 'many', 1, browser, checkScroll)
  await runCheck(() => checkFirstSync(browser))
  await runCheck(() => checkRollback(browser))
  await runCheck(() => checkReply(browser))
  await runCheck(() => checkCompose(browser))
  await runCheck(() => checkLostCore(browser))
  await runCheck(() => checkAttachments(browser))
  await runCheck(() => checkBody(browser))
  await runCheck(() => checkColors(browser))
} finally {
  await browser.close()
}

summarize()
process.exitCode = failed() ? 1 : 0
