// Saving and opening an attachment for the page. The page names the file by blob id only,
// through the preload, and gets back what happened, never a path. Main asks the core for
// the bytes (core.ts), and the name and type come from the core, not the page.
//
//   save  fetches the file to a private temp folder, asks where to save it with the native
//         dialog, copies it there, and removes the temp copy.
//   open  fetches the file into a temp folder of its own, under its cleaned name, then hands
//         it to the OS, which opens it with the app it picks for that type. Main never runs a
//         file. A type that can run code (files.ts) gets a native warning first, and opens
//         only if the person chooses to. The copy is readable by this user only and has no
//         execute bit, and on Windows and macOS it is marked as from the internet, so the OS
//         applies its own checks too. It stays after the app quits, since the app that
//         opened it may still be using it: the OS clears its temp folder.
//
// The Electron check (packages/dev-host/src/electron-attachments.ts) drives both with the
// dialogs and the OS call stubbed.

import { execFile } from 'node:child_process'
import { createReadStream, createWriteStream, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { app, type BrowserWindow, dialog, shell } from 'electron'
import type { AttachmentOutcome } from '@letterbox/client/message-port'
import type { BlobId } from '@letterbox/protocol'
import type { CoreSession, Fetched } from './core.ts'
import { safeName, runsCode } from './files.ts'
import { log } from './log.ts'

/** The folder this run keeps its temp copies in, made on first use. */
let root: string | undefined

/** A new folder of its own for one save or open, inside this run's temp folder. Readable by this user only. */
const scratch = (kind: 'save' | 'open') => {
  root ??= mkdtempSync(join(app.getPath('temp'), 'letterbox-'))
  return mkdtempSync(join(root, `${kind}-`))
}

/** What the page hears when the core did not hand over the file. */
const failed = (fetched: Extract<Fetched, { ok: false }>): AttachmentOutcome => {
  if (fetched.error === 'ended' || fetched.error === 'unwritable') return { ok: false, reason: 'failed' }
  return { ok: false, reason: fetched.error }
}

/** Fetches the file into `folder`. The name it lands under is not the attachment's, which comes with the answer. */
const fetchInto = (session: CoreSession, blobId: BlobId, folder: string) =>
  session.attachment(blobId, join(folder, 'download'))

/** Asks where to save the attachment and copies it there. */
export async function saveAttachment(session: CoreSession, window: BrowserWindow, blobId: BlobId) {
  const folder = scratch('save')
  try {
    const fetched = await fetchInto(session, blobId, folder)
    if (!fetched.ok) return failed(fetched)
    const chosen = await dialog.showSaveDialog(window, {
      defaultPath: join(app.getPath('downloads'), safeName(fetched.file.name)),
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    })
    if (chosen.canceled || chosen.filePath === undefined) return { ok: false, reason: 'cancelled' } as const
    // A new file gets the user's usual permissions, without an execute bit.
    await pipeline(createReadStream(join(folder, 'download')), createWriteStream(chosen.filePath))
    return { ok: true } as const
  } catch (error) {
    log(`could not save an attachment: ${String(error)}`)
    return { ok: false, reason: 'failed' } as const
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
}

/** Opens a copy of the attachment with the OS's app for its type, after a warning for one that can run code. */
export async function openAttachment(
  session: CoreSession,
  window: BrowserWindow,
  blobId: BlobId,
): Promise<AttachmentOutcome> {
  const folder = scratch('open')
  let opened = false
  try {
    const fetched = await fetchInto(session, blobId, folder)
    if (!fetched.ok) return failed(fetched)
    const name = safeName(fetched.file.name)
    if (runsCode(name) && !(await confirmOpen(window, name))) return { ok: false, reason: 'declined' }
    const path = join(folder, name)
    renameSync(join(folder, 'download'), path)
    await markFromInternet(path)
    const problem = await shell.openPath(path)
    if (problem !== '') {
      log(`the OS could not open an attachment: ${problem}`)
      return { ok: false, reason: 'failed' }
    }
    opened = true
    return { ok: true }
  } catch (error) {
    log(`could not open an attachment: ${String(error)}`)
    return { ok: false, reason: 'failed' }
  } finally {
    if (!opened) rmSync(folder, { recursive: true, force: true })
  }
}

/** Asks with a native warning whether to open a file that can run code. Cancel is the default. */
async function confirmOpen(window: BrowserWindow, name: string) {
  const answer = await dialog.showMessageBox(window, {
    type: 'warning',
    message: `"${name}" can run programs on this computer`,
    detail:
      'Open it only if you know who sent it and you expected it. Your system will open it with the app it uses for this type of file.',
    buttons: ['Cancel', 'Open'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  })
  return answer.response === 1
}

/**
 * Marks a file as downloaded from the internet, so the OS checks it as it would a browser
 * download: the Zone.Identifier stream Windows' Attachment Manager and SmartScreen read, and
 * the quarantine attribute macOS Gatekeeper reads. Linux has no such mark. Best effort: a
 * file system without the stream or the attribute keeps the file unmarked.
 */
async function markFromInternet(path: string) {
  try {
    if (process.platform === 'win32') writeFileSync(`${path}:Zone.Identifier`, '[ZoneTransfer]\r\nZoneId=3\r\n')
    // The value is flags, the time in hex seconds, and the app that saved it.
    const stamp = `0081;${Math.floor(Date.now() / 1000).toString(16)};Letterbox;`
    if (process.platform === 'darwin') await run('/usr/bin/xattr', ['-w', 'com.apple.quarantine', stamp, path])
  } catch (error) {
    log(`could not mark an attachment as from the internet: ${String(error)}`)
  }
}

const run = promisify(execFile)
