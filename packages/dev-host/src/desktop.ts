// The desktop shell as the dev host runs it: built from source, started on Electron with the
// environment its main reads (apps/desktop/shell/src/main/config.ts). Main starts the core
// itself, exactly as the app does. The dev host only says which core, and where the page is.

import { createWriteStream } from 'node:fs'
import { join } from 'node:path'
import { buildShell, electronBinary, SHELL } from '@letterbox/desktop-shell/build'
import { type Child, startChild } from './children.ts'
import { coreProgram, type Paths } from './core.ts'

/** Which core the shell runs: core-sim against the dev host's provider, or the app's own over Gmail. */
export type DesktopCore = { kind: 'sim'; now: string } | { kind: 'gmail'; client: string | undefined }

/**
 * The environment the shell's main reads. Every LETTERBOX_ variable of this process is left
 * out, so a stray one in a terminal cannot change the run.
 */
export function shellEnv(paths: Paths, renderer: string, core: DesktopCore): Record<string, string> {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && !entry[0].startsWith('LETTERBOX_'),
    ),
  )
  // Chromium's own state goes next to the core's store, never to the user's config folder.
  const shared = {
    ...inherited,
    LETTERBOX_RENDERER: renderer,
    LETTERBOX_DATA: paths.data,
    LETTERBOX_USER_DATA: join(paths.data, '..', 'electron'),
  }
  if (core.kind === 'gmail') {
    return {
      ...shared,
      LETTERBOX_CORE: 'gmail',
      LETTERBOX_CORE_PROGRAM: coreProgram(paths, 'letterbox-core'),
      ...(core.client !== undefined && { LETTERBOX_GMAIL_CLIENT: core.client }),
    }
  }
  return {
    ...shared,
    LETTERBOX_CORE: 'sim',
    LETTERBOX_CORE_PROGRAM: coreProgram(paths, 'core-sim'),
    LETTERBOX_SIM_SOCKET: paths.socket,
    LETTERBOX_SIM_NOW: core.now,
  }
}

/** Says why Electron cannot open a window here, or undefined if it can. Only Linux can lack a display. */
export function missingDisplay(): string | undefined {
  if (process.platform !== 'linux' || process.env.DISPLAY || process.env.WAYLAND_DISPLAY) return undefined
  return 'Electron needs a display, and neither DISPLAY nor WAYLAND_DISPLAY is set. Run under xvfb-run -a, or on WSLg set DISPLAY=:0.'
}

/** Builds the shell and starts it on Electron. Its stdout and stderr go to `log`. */
export async function launchDesktop(paths: Paths, renderer: string, core: DesktopCore, log: string): Promise<Child> {
  await buildShell()
  const electron = startChild(electronBinary(), [SHELL], paths.root, shellEnv(paths, renderer, core))
  const out = createWriteStream(log, { flags: 'a' })
  electron.stdout.pipe(out)
  electron.stderr.pipe(out)
  return electron
}
