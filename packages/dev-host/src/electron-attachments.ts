// The attachments run of the Electron check (electron-check.ts): the page saves and opens
// files through the bridge, with main's save dialog, warning dialog and OS open call stubbed
// inside main, so nothing reaches the desktop. It checks the bytes that land on disk, the
// names main gives them, the warning before a file that can run code, that the page never
// sees a path, and that every temp copy but the opened ones is gone afterwards.

import { mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
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
}

declare global {
  var letterboxStubs: Stubs | undefined
}

const KEY = 'files-for-the-check'
const SUBJECT = 'Files for the check'
/** A file of a little over three chunks, and one whose name tries a path, a hidden file and a reversed extension. */
const FILES = [
  { name: 'Q3 report.pdf', mime: 'application/pdf', size: 3 * 64 * 1024 + 5 },
  { name: '../setup‮fdp.exe', mime: 'application/octet-stream', size: 2048 },
]

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
      text: 'Two files for the check.',
      sentAt: seed.now,
      attachments: FILES,
    })
    await app.evaluate(({ dialog, shell }) => {
      const stubs: Stubs = { saveTo: null, warningAnswer: 0, offered: [], warned: [], opened: [] }
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
    const [report, setup] = files ?? []
    if (!report || !setup) throw new Error(`the conversation lists ${files?.length ?? 0} files, not 2`)
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
    equal(statSync(opened).mode & 0o777, 0o600, "attachments: the copy is the user's only, and not executable")
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

    equal(
      readdirSync(dirname(dirname(opened))).toSorted(),
      [basename(dirname(opened)), basename(dirname(program))].toSorted(),
      'attachments: only the two opened copies are left in the temp folder',
    )
    equal(
      await page.evaluate(() => window.letterbox?.saveAttachment(42 as never)),
      { ok: false, reason: 'gone' },
      'attachments: a blob id that is not a string names no file',
    )
    checkQuit('attachments', run, await quit(run))
  })
