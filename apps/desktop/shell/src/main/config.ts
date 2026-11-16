// Which core main runs and where the page comes from, read from the environment:
//
//   LETTERBOX_RENDERER      required. A dev server's http URL (Vite, with HMR), or a folder
//                           that holds a built renderer, served as app://renderer/.
//   LETTERBOX_CORE          'gmail' (the default) or 'sim'.
//   LETTERBOX_CORE_PROGRAM  required. letterbox-core for gmail, core-sim for sim.
//   LETTERBOX_GMAIL_CLIENT  gmail: the JSON file Google Cloud Console downloads for an OAuth
//                           client of type Desktop app. Never bundled, never in the repo.
//   LETTERBOX_SIM_SOCKET    sim: the sim provider's socket.
//   LETTERBOX_SIM_NOW       sim: the fixed time the core runs at.
//   LETTERBOX_USER_DATA     optional. Electron's own state. Defaults to Electron's folder.
//   LETTERBOX_DATA          optional. The core's store. Defaults to <user data>/core.
//
// packages/dev-host sets these for `pnpm dev:desktop` and the Electron check.

import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** Where the page comes from. */
export type Renderer = { kind: 'server'; url: URL } | { kind: 'folder'; folder: string }

/** Which core to start, before its store is known. */
export type CoreChoice =
  | { kind: 'gmail'; program: string; client: string }
  | { kind: 'sim'; program: string; socket: string; now: string }

export type Config = {
  renderer: Renderer
  core: CoreChoice
  userData: string | undefined
  data: string | undefined
}

/** A program and its arguments. */
export type CoreCommand = { program: string; args: string[] }

type Env = Record<string, string | undefined>

/** Reads the config, or says everything that is wrong with it. */
export function readConfig(env: Env): { ok: true; config: Config } | { ok: false; problems: string[] } {
  const problems: string[] = []
  /** A variable that must be set. Notes a problem and gives '' when it is not. */
  const required = (name: string, what: string) => {
    const value = env[name]
    if (value === undefined || value === '') problems.push(`${name} is not set. Set it to ${what}.`)
    return value ?? ''
  }
  /** A path that must exist. Notes a problem when it does not. */
  const existing = (name: string, what: string, hint = '') => {
    const value = required(name, what)
    if (value !== '' && !existsSync(value)) problems.push(`${name} names ${value}, which does not exist.${hint}`)
    return resolve(value)
  }

  const page = required('LETTERBOX_RENDERER', 'a dev server URL or a built renderer folder')
  const renderer = page === '' ? undefined : readRenderer(page)
  if (typeof renderer === 'string') problems.push(renderer)

  const kind = env.LETTERBOX_CORE ?? 'gmail'
  const program = existing('LETTERBOX_CORE_PROGRAM', 'the core program', ' Build it with cargo build.')
  let core: CoreChoice | undefined
  if (kind === 'gmail') {
    const client = existing(
      'LETTERBOX_GMAIL_CLIENT',
      'the JSON file Google Cloud Console downloads for an OAuth client of type Desktop app',
    )
    core = { kind, program, client }
  } else if (kind === 'sim') {
    const socket = required('LETTERBOX_SIM_SOCKET', "the sim provider's socket")
    const now = required('LETTERBOX_SIM_NOW', 'the time the sim core runs at')
    core = { kind, program, socket, now }
  } else {
    problems.push(`LETTERBOX_CORE is ${kind}. Set it to gmail or sim.`)
  }

  if (problems.length > 0 || core === undefined || renderer === undefined || typeof renderer === 'string') {
    return { ok: false, problems }
  }
  return {
    ok: true,
    config: { renderer, core, userData: optionalPath(env.LETTERBOX_USER_DATA), data: optionalPath(env.LETTERBOX_DATA) },
  }
}

/** The renderer that `value` names, or why it names none. */
function readRenderer(value: string): Renderer | string {
  if (/^https?:\/\//.test(value)) return { kind: 'server', url: new URL(value) }
  const folder = resolve(value)
  if (!existsSync(join(folder, 'index.html'))) return `LETTERBOX_RENDERER names ${folder}, which has no index.html.`
  return { kind: 'folder', folder }
}

const optionalPath = (value: string | undefined) => (value === undefined || value === '' ? undefined : resolve(value))

/** The command line that starts `core` over the store at `data`. */
export function coreCommand(core: CoreChoice, data: string): CoreCommand {
  switch (core.kind) {
    case 'gmail':
      return { program: core.program, args: ['--data', data, '--gmail-client', core.client] }
    case 'sim':
      return { program: core.program, args: ['--data', data, '--sim', core.socket, '--now', core.now] }
  }
}
