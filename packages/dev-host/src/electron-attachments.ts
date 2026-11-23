// The attachments run of the Electron check (electron-check.ts): the page saves and opens
// files through the bridge, with main's save dialog, warning dialog and OS open call stubbed
// inside main, so nothing reaches the desktop. It checks the bytes that land on disk, the
// names main gives them, the warning before a file that can run code, long names cut so they
// keep their extension and end in neither a dot nor a space, that a save that fails part
// way leaves the file it would replace as it was, that the page never sees a path, and that
// every temp copy but the opened ones is gone afterwards. Then the reader's rows: they mark
// the files main warns about, and their Save, Open and Retry reach the same shell.

import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { safeName } from '@letterbox/client/files'
import type { BlobId } from '@letterbox/protocol'
import { checkQuit, equal, quit, seed, STATE, WAIT_MS, withApp, within } from './electron-app.ts'
import type { DevServer } from './server.ts'
import type { RunningSim } from './sim.ts'

/** What the stubs in main answer with and what they were asked, kept on main's globalThis. */
type Stubs = {
  /** Where the save dialog "chooses" to save, or null to cancel it. */
  saveTo: string | null
  /** The button the warning dialog "presses": 0 is Cancel, 1 is Open. */
  warningAnswer: number
  /** The default path each save dialog offered. */
  offered: string[]
  /** The message of each warning shown. */
  warned: string[]
  /** Each path handed to the OS to open. */
  opened: string[]
  /** Each url main handed the OS to open in the browser. */
  external: string[]
}

declare global {
  var letterboxStubs: Stubs | undefined
}

const KEY = 'files-for-the-check'
const SUBJECT = 'Files for the check'
/**
 * A file of a little over three chunks, one whose name tries a path, a hidden file and a
 * reversed extension, and names over the 200 bytes main keeps: two the cut leaves ending in
 * ".exe." and ".exe ", which Windows creates as ".exe", and two whose risky extension sits
 * past byte 200, and a macOS shortcut, which opens whatever URL it holds.
 */
const FILES = [
  { name: 'Q3 report.pdf', mime: 'application/pdf', size: 3 * 64 * 1024 + 5 },
  { name: '../setup‮fdp.exe', mime: 'application/octet-stream', size: 2048 },
  { name: `${'a'.repeat(195)}.exe.${'b'.repeat(40)}`, mime: 'application/octet-stream', size: 10 },
  { name: `${'c'.repeat(195)}.exe ${'b'.repeat(40)}`, mime: 'application/octet-stream', size: 10 },
  { name: `${'d'.repeat(300)}.exe`, mime: 'application/octet-stream', size: 10 },
  { name: `${'e'.repeat(300)}.settingcontent-ms`, mime: 'application/octet-stream', size: 10 },
  { name: 'Office map.webloc', mime: 'application/octet-stream', size: 10 },
]

/** The warning main shows before it opens a file of this name. */
const warning = (name: string) => `"${name}" can run programs on this computer`

export const attachmentsRun = (sim: RunningSim, server: DevServer) =>
  withApp('attachments', server.url, async (run) => {
    const { app, page } = run
    const saved = join(STATE, 'saved')
    mkdirSync(saved, { recursive: true })
    sim.mailbox.deliver({
      key: KEY,
      mailboxes: ['inbox'],
      from: { name: 'Ana Check', address: 'ana@files.example' },
      to: [seed.seed.address],
      subject: SUBJECT,
      text: 'Files for the check.',
      sentAt: seed.now,
      attachments: FILES,
    })
    await app.evaluate(({ dialog, shell }) => {
      const stubs: Stubs = { saveTo: null, warningAnswer: 0, offered: [], warned: [], opened: [], external: [] }
      globalThis.letterboxStubs = stubs
      dialog.showSaveDialog = async (...args: unknown[]) => {
        const options = args.at(-1)
        const offered = typeof options === 'object' && options !== null ? Reflect.get(options, 'defaultPath') : null
        stubs.offered.push(String(offered))
        return stubs.saveTo === null ? { canceled: true, filePath: '' } : { canceled: false, filePath: stubs.saveTo }
      }
      dialog.showMessageBox = async (...args: unknown[]) => {
        const options = args.at(-1)
        const message = typeof options === 'object' && options !== null ? Reflect.get(options, 'message') : null
        stubs.warned.push(String(message))
        return { response: stubs.warningAnswer, checkboxChecked: false }
      }
      shell.openPath = async (path: string) => {
        stubs.opened.push(path)
        return ''
      }
      shell.openExternal = async (url: string) => {
        stubs.external.push(url)
      }
    })
    /** Sets what the stubs answer next. */
    const answer = (saveTo: string | null, warningAnswer: number) =>
      app.evaluate((_electron, given) => Object.assign(globalThis.letterboxStubs ?? {}, given), {
        saveTo,
        warningAnswer,
      })
    const asked = async (): Promise<Stubs> => {
      const stubs = await app.evaluate(() => globalThis.letterboxStubs)
      if (!stubs) throw new Error('the stubs are not in main')
      return stubs
    }

    await page.waitForFunction(() => window.letterboxDev !== undefined, null, { timeout: WAIT_MS })
    const files = await within(
      page.evaluate((subject) => window.letterboxDev?.attachments(subject), SUBJECT),
      'the conversation with the files',
    )
    const [report, setup, ...rest] = files ?? []
    const long = rest.slice(0, 4)
    const [shortcut] = rest.slice(4)
    if (!report || !setup || !shortcut || long.length !== 4)
      throw new Error(`the conversation lists ${files?.length ?? 0} files, not ${FILES.length}`)
    // Bounded, so main never answering fails the check instead of hanging it.
    const save = (blobId: BlobId) =>
      within(
        page.evaluate((id) => window.letterbox?.saveAttachment(id), blobId),
        'a save',
      )
    const open = (blobId: BlobId) =>
      within(
        page.evaluate((id) => window.letterbox?.openAttachment(id), blobId),
        'an open',
      )
    const bytesOf = (index: number) => sim.mailbox.attachmentBytes(KEY, index)

    // A frame that is not our page cannot ask at all. It asks first, so no limit stops it but that.
    await app.evaluate(({ ipcMain }) => {
      ipcMain.emit('url:open', { sender: null, senderFrame: null }, 'https://elsewhere.example/u')
    })
    // A page the person chose, as an unsubscribe page: main opens https with no user name or
    // password, at most one a second. The last two go together, inside one second.
    await page.evaluate(() => {
      window.letterbox?.openPage('http://plain.example/u')
      window.letterbox?.openPage('file:///etc/hosts')
      window.letterbox?.openPage('https://member:secret@bramblebooks.example/unsubscribe')
      window.letterbox?.openPage('https://bramblebooks.example/unsubscribe?u=9')
      window.letterbox?.openPage('https://bramblebooks.example/unsubscribe?u=10')
    })
    // The page's next ask to main goes after those, so main has read them once it answers.
    // A blob id too long to be one is answered at once, with no dialog.
    await open('x'.repeat(201) as BlobId)
    equal(
      (await asked()).external,
      ['https://bramblebooks.example/unsubscribe?u=9'],
      'pages: main opens only an https page with no user name or password, one a second, and only for our page',
    )

    const target = join(saved, 'chosen.pdf')
    await answer(target, 0)
    equal(await save(report.blobId), { ok: true }, 'attachments: a save answers ok, and no path')
    equal(basename((await asked()).offered[0] ?? ''), 'Q3 report.pdf', 'attachments: the dialog offers the file name')
    equal(readFileSync(target).equals(bytesOf(0)), true, 'attachments: the saved file holds the bytes the provider has')

    await answer(null, 0)
    equal(
      await save(report.blobId),
      { ok: false, reason: 'cancelled' },
      'attachments: a cancelled dialog saves nothing',
    )

    sim.mailbox.setOffline(true)
    equal(await save(report.blobId), { ok: false, reason: 'offline' }, 'attachments: offline, a save says so')
    equal((await asked()).offered.length, 2, 'attachments: offline, no dialog opens for a file main does not have')
    sim.mailbox.setOffline(false)

    equal(await open(report.blobId), { ok: true }, 'attachments: an open answers ok')
    const [opened] = (await asked()).opened
    if (opened === undefined) throw new Error('main handed nothing to the OS to open')
    equal(basename(opened), 'Q3 report.pdf', 'attachments: the OS opens a copy under the file name')
    equal(readFileSync(opened).equals(bytesOf(0)), true, 'attachments: the copy holds the bytes the provider has')
    // Windows keeps no mode bits, so Node reports 0o666 there. It gets the internet mark instead.
    if (process.platform === 'win32') {
      equal(
        readFileSync(`${opened}:Zone.Identifier`, 'utf8').includes('ZoneId=3'),
        true,
        'attachments: on Windows the copy is marked as from the internet',
      )
    } else {
      equal(statSync(opened).mode & 0o777, 0o600, "attachments: the copy is the user's only, and not executable")
    }
    if (process.platform === 'darwin') {
      const quarantine = execFileSync('/usr/bin/xattr', ['-p', 'com.apple.quarantine', opened], { encoding: 'utf8' })
      equal(quarantine.includes(';Letterbox;'), true, 'attachments: on macOS the copy is quarantined')
    }
    equal((await asked()).warned, [], 'attachments: a PDF opens without a warning')

    equal(await open(setup.blobId), { ok: false, reason: 'declined' }, 'attachments: a cancelled warning opens nothing')
    equal(
      (await asked()).warned,
      ['"_setupfdp.exe" can run programs on this computer'],
      'attachments: a program gets a warning, under its cleaned name: no path, no leading dot, no reversed text',
    )
    equal((await asked()).opened.length, 1, 'attachments: the declined program never reached the OS')

    await answer(null, 1)
    equal(await open(setup.blobId), { ok: true }, 'attachments: a program the person chose to open opens')
    const program = (await asked()).opened[1] ?? ''
    equal(
      [basename(program), dirname(dirname(program)) === dirname(dirname(opened))],
      ['_setupfdp.exe', true],
      "attachments: it opens under its cleaned name, inside main's temp folder",
    )
    equal(readFileSync(program).equals(bytesOf(1)), true, 'attachments: the program copy holds its own bytes')

    await answer(null, 0)
    // oxlint-disable-next-line no-await-in-loop -- one open at a time, so the warnings come in order
    for (const file of long) await open(file.blobId)
    equal(
      (await asked()).warned.slice(2),
      [
        warning(`${'a'.repeat(195)}.exe`),
        warning(`${'c'.repeat(195)}.exe`),
        warning(`${'d'.repeat(196)}.exe`),
        warning(`${'e'.repeat(182)}.settingcontent-ms`),
      ],
      'attachments: a long name is cut to keep its extension, with no dot or space at its end, and a program still warns',
    )
    await open(shortcut.blobId)
    equal(
      (await asked()).warned.at(-1),
      warning('Office map.webloc'),
      'attachments: a macOS shortcut, which opens the URL inside it, warns too',
    )

    equal(
      readdirSync(dirname(dirname(opened))).toSorted(),
      [basename(dirname(opened)), basename(dirname(program))].toSorted(),
      'attachments: only the two opened copies are left in the temp folder',
    )
    // A sender can name a file anything, at any length, and the reader cleans the name as a
    // conversation opens. The cleaning takes time in proportion to the name, not its square.
    const hostile = ['a'.repeat(100_000), `a${' '.repeat(100_000)}b`, '中'.repeat(100_000), '.'.repeat(100_000)]
    const timings = hostile.map((name) => {
      const started = performance.now()
      const cleaned = safeName(`${name}.exe`)
      return { ms: performance.now() - started, bytes: new TextEncoder().encode(cleaned).length }
    })
    equal(
      timings.map((timing) => timing.ms < 50 && timing.bytes <= 201),
      [true, true, true, true],
      `attachments: names of 100,000 characters clean in under 50 ms each, to at most 200 bytes (${timings.map((timing) => timing.ms.toFixed(1)).join(', ')} ms)`,
    )

    // A disk that fills up part way through the copy, over a file the person chose to replace.
    const kept = join(saved, 'kept.pdf')
    writeFileSync(kept, 'the file the person had')
    await answer(kept, 0)
    await app.evaluate(() => {
      const fs = process.getBuiltinModule('node:fs')
      const { syncBuiltinESMExports } = process.getBuiltinModule('node:module')
      const real = fs.createWriteStream
      // Once: the next stream writes its first chunk, then fails every write after it.
      fs.createWriteStream = (...args: Parameters<typeof real>) => {
        fs.createWriteStream = real
        syncBuiltinESMExports()
        const stream = real(...args)
        // oxlint-disable-next-line no-underscore-dangle -- the fault goes into the stream's own write, which Node names so
        const write = stream._write.bind(stream)
        const full = new Error('ENOSPC: no space left on device, write')
        let writes = 0
        // oxlint-disable-next-line no-underscore-dangle -- the fault goes into the stream's own write, which Node names so
        stream._write = (chunk, encoding, done) => ((writes += 1) === 1 ? write(chunk, encoding, done) : done(full))
        // oxlint-disable-next-line no-underscore-dangle -- the fault goes into the stream's own write, which Node names so
        stream._writev = (_chunks, done) => done(full)
        return stream
      }
      syncBuiltinESMExports()
    })
    equal(await save(report.blobId), { ok: false, reason: 'failed' }, 'attachments: a save the disk cuts short fails')
    equal(
      [readFileSync(kept, 'utf8'), readdirSync(saved).toSorted()],
      ['the file the person had', ['chosen.pdf', 'kept.pdf']],
      'attachments: it leaves the file it would replace as it was, and no part of the copy beside it',
    )

    equal(
      await page.evaluate(() => window.letterbox?.saveAttachment(42 as never)),
      { ok: false, reason: 'gone' },
      'attachments: a blob id that is not a string names no file',
    )

    // From the reader: each row's Save and Open reach the same shell, and the row shows what came of it.
    // The OS clamps the window to its screen, and under 1100 px wide (a 1024 by 768 CI runner) the
    // sidebar folds behind its toggle, so the check opens it the way a person would.
    const toggle = page.getByRole('button', { name: 'Show the sidebar' })
    if (await toggle.isVisible()) await toggle.click()
    await page
      .getByRole('navigation', { name: 'Sidebar' })
      .getByRole('button', { name: /^Inbox/ })
      .click()
    await page.locator('[data-list="mail"] [role="option"]', { hasText: SUBJECT }).first().click()
    const row = (name: string) =>
      page
        .locator('[data-message="open"] [data-field="attachment"]')
        .filter({ has: page.locator('[data-field="name"]', { hasText: name }) })
    /** Clicks a row's button, and waits until the shell has answered and the row shows it. */
    const press = async (action: 'Open' | 'Save' | 'Retry', name: string) => {
      await page.getByRole('button', { name: `${action} ${name}`, exact: true }).click()
      await row(name).and(page.locator('[data-state="rest"], [data-state="failed"]')).waitFor({ timeout: WAIT_MS })
      return row(name).getAttribute('data-state')
    }
    const REPORT = 'Q3 report.pdf'
    const SETUP = '_setupfdp.exe'
    await row(REPORT).waitFor({ timeout: WAIT_MS })
    await row(SETUP).waitFor({ timeout: WAIT_MS })
    // The reader reads the same rules as main (@letterbox/client/files), so it marks at rest
    // exactly the files main warned about above, under the names main warned with.
    const marked = await page
      .locator('[data-message="open"] [data-field="attachment"]:has([data-field="program"]) [data-field="name"]')
      .allTextContents()
    equal(
      marked.map(warning).toSorted(),
      [...new Set((await asked()).warned)].toSorted(),
      'attachments: the reader marks as a program exactly the files main warns about, under the names it warns with',
    )
    equal(await row(REPORT).locator('[data-field="program"]').count(), 0, 'attachments: the reader marks no PDF')

    const fromReader = join(saved, 'from-the-reader.pdf')
    await answer(fromReader, 0)
    equal(await press('Save', REPORT), 'rest', "attachments: Save on the reader's row comes back to rest")
    equal(readFileSync(fromReader).equals(bytesOf(0)), true, 'attachments: it saved the bytes the provider has')

    const before = await asked()
    await answer(null, 0)
    equal(await press('Open', SETUP), 'rest', "attachments: declining main's warning leaves the program's row at rest")
    const after = await asked()
    equal(
      [after.warned.slice(before.warned.length), after.opened.length - before.opened.length],
      [[warning(SETUP)], 0],
      "attachments: Open on the program's row brings main's one warning, for that program, and nothing opens",
    )
    equal(await press('Open', REPORT), 'rest', "attachments: Open on the PDF's row comes back to rest")
    equal(
      basename((await asked()).opened.at(-1) ?? ''),
      REPORT,
      "attachments: the OS opened the PDF from the reader's row",
    )

    sim.mailbox.setOffline(true)
    equal(
      [await press('Save', REPORT), await row(REPORT).locator('[data-field="failed"]').textContent()],
      ['failed', 'Couldn’t fetch · offline'],
      'attachments: offline, the row says it could not fetch the file',
    )
    sim.mailbox.setOffline(false)
    const retried = join(saved, 'retried.pdf')
    await answer(retried, 0)
    equal(await press('Retry', REPORT), 'rest', 'attachments: back online, Retry saves it')
    equal(readFileSync(retried).equals(bytesOf(0)), true, 'attachments: the retried save holds the same bytes')
    checkQuit('attachments', run, await quit(run))
  })
