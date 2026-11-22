// End-to-end check of `letterbox-core`, the program the desktop app spawns (crates/host).
// Run from the repo root: node packages/harness/src/app-host.ts
//
// Builds the program, then runs it in a throwaway folder with a dummy OAuth client file:
//   - each kind of bad argument exits with 2 and says what is wrong, before any store is made
//   - with good arguments, hello is welcomed and sign-in-options lists Gmail
//   - closing stdin ends the program with exit code 0
//   - the store it makes holds an id, which names its keychain entries: a second start on the
//     same store keeps it, and a new store gets one of its own
//   - it starts on a store that has its id while another connection holds the store's write lock
// Nothing signs in, so nothing reaches Google or the keychain. Writes the transcript to
// artifacts/app-host/letterbox-core.jsonl. It holds no paths or times, so every run writes the same file.
// CI runs it on Linux, macOS and Windows. Only the OS's words for a missing file differ.

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { createClient, type Listener } from '@letterbox/client'
import type { CoreMessage } from '@letterbox/protocol'
import { coreMessageProblem } from '@letterbox/protocol/parse'
import type { TranscriptEntry } from './client.ts'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const PROGRAM = join(ROOT, 'target/debug', process.platform === 'win32' ? 'letterbox-core.exe' : 'letterbox-core')
/** How the OS words a missing file, which the program passes on. */
const NO_SUCH_FILE =
  process.platform === 'win32'
    ? 'The system cannot find the file specified. (os error 2)'
    : 'No such file or directory (os error 2)'
const ARTIFACTS = join(ROOT, 'artifacts', 'app-host')
/** How long the program gets to answer or to exit. */
const WAIT_MS = 5000
/** What crates/host writes to stderr once stdin closes. */
const INPUT_CLOSED = 'letterbox-core: input closed, finishing the work in flight'

/** A client file shaped like the one Google Cloud Console downloads. Nothing accepts this client. */
const DUMMY_CLIENT = {
  installed: {
    client_id: 'letterbox-check.apps.example.invalid',
    client_secret: 'not-a-secret',
    redirect_uris: ['http://localhost'],
  },
}

/** Bad command lines, run from the throwaway folder, and the first line each must write to stderr. */
const BAD_ARGUMENTS: [string[], string][] = [
  [[], 'letterbox-core: --data is required'],
  [['--data', 'data'], 'letterbox-core: --gmail-client is required'],
  [['--data', 'data', '--gmail-client'], 'letterbox-core: --gmail-client needs a value'],
  [['--data', 'data', '--data', 'data'], 'letterbox-core: --data is given more than once'],
  [['--data', 'data', '--sim', 'socket'], 'letterbox-core: unknown argument "--sim"'],
  [
    ['--data', 'data', '--gmail-client', 'missing.json'],
    `letterbox-core: --gmail-client missing.json: cannot read it: ${NO_SUCH_FILE}`,
  ],
  [
    ['--data', 'data', '--gmail-client', 'web-client.json'],
    'letterbox-core: --gmail-client web-client.json: it has no "installed" client. Download the JSON of an OAuth client of type Desktop app',
  ],
]

const transcript: TranscriptEntry[] = []
const record = (entry: TranscriptEntry) => void transcript.push(entry)
const failures: string[] = []
const check = (ok: boolean, what: string) => {
  record({ from: 'scenario', note: `${ok ? 'ok' : 'FAILED'}: ${what}` })
  if (!ok) failures.push(what)
}

/** Rejects unless `promise` settles within WAIT_MS. */
const within = <T>(what: string, promise: Promise<T>) =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`timed out after ${WAIT_MS} ms waiting for ${what}`)), WAIT_MS).unref(),
    ),
  ])

/** Runs the program with bad arguments and checks it refuses them. */
function checkBadArguments(folder: string) {
  for (const [args, expected] of BAD_ARGUMENTS) {
    const run = spawnSync(PROGRAM, args, { cwd: folder, encoding: 'utf8', timeout: WAIT_MS })
    const said = run.stderr.split('\n')[0] ?? ''
    const ok = run.status === 2 && said === expected
    const command = ['letterbox-core', ...args].join(' ')
    check(ok, `\`${command}\` exits 2 and says: ${expected}${ok ? '' : ` (exited ${run.status} and said: ${said})`}`)
  }
  check(!existsSync(join(folder, 'data')), 'no bad command line made a data folder')
}

/**
 * Starts the program with good arguments on the store in `data`, drives it as a UI would, and
 * closes its input. `beforeClose` runs once the UI part is done, before the input closes.
 */
async function checkSession(folder: string, data: string, beforeClose?: () => void) {
  const child = spawn(PROGRAM, ['--data', data, '--gmail-client', 'client.json'], {
    cwd: folder,
    stdio: ['pipe', 'pipe', 'pipe'],
    // Points any keychain call at a bus that does not exist, so a mistake fails here
    // instead of reaching the keyring of whoever runs the check.
    env: { ...process.env, DBUS_SESSION_BUS_ADDRESS: 'unix:path=/nonexistent' },
  })
  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => void (stderr += chunk.toString()))
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)))

  let listener: Listener | undefined
  createInterface({ input: child.stdout }).on('line', (line) => {
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      value = undefined
    }
    const problem = value === undefined ? 'it is not JSON' : coreMessageProblem(value)
    if (problem !== null) return check(false, `the core sends only protocol messages, not (${problem}): ${line}`)
    // coreMessageProblem accepted every field, so this value is a CoreMessage.
    const message = value as CoreMessage
    record({ from: 'core', message })
    listener?.receive(message)
  })
  void exited.then((code) => listener?.end(new Error(`letterbox-core exited with code ${code}. stderr:\n${stderr}`)))

  let ids = 0
  const client = createClient(
    {
      send: (message) => {
        record({ from: 'ui', message })
        child.stdin.write(`${JSON.stringify(message)}\n`)
      },
      listen: (given) => void (listener = given),
    },
    { newId: (kind) => `${kind}_${++ids}`, unclaimed: 'keep' },
  )

  try {
    const welcome = await within('a welcome', client.hello())
    check(welcome.kind === 'welcome', 'hello is welcomed')
    const options = client.subscribe({ view: 'sign-in-options' })
    const listed = await within('the sign-in options', options.next())
    check(
      isDeepStrictEqual(listed, [{ id: 'gmail', label: 'Gmail', method: 'oauth' }]),
      'the only sign-in option is Gmail, by oauth',
    )
    options.close()
  } catch (error) {
    check(false, error instanceof Error ? error.message : String(error))
  }
  beforeClose?.()

  record({ from: 'scenario', note: 'stdin closes' })
  child.stdin.end()
  const timer = setTimeout(() => child.kill(), WAIT_MS)
  const code = await exited
  clearTimeout(timer)
  check(stderr.includes(INPUT_CLOSED), 'it says it read the end of its input')
  check(code === 0, `it exits with code 0 once stdin closes (got ${code})`)
  check(existsSync(join(folder, data)), 'it made its store in the --data folder')
}

/** The id the program saved in the store in `data`, read from its database. */
function storeIdOf(data: string) {
  using db = new DatabaseSync(join(data, 'letterbox.sqlite'))
  const row = db.prepare('select id from identity').get()
  return typeof row?.id === 'string' ? row.id : undefined
}

/** Whether `id` is shaped like a store id: 32 hex digits. */
const isId = (id: string | undefined) => id !== undefined && /^[0-9a-f]{32}$/.test(id)

/** Starts the program on one store twice, then on a new store, and compares the ids they hold. */
async function checkStoreIds(folder: string) {
  await checkSession(folder, 'data')
  const first = storeIdOf(join(folder, 'data'))
  check(isId(first), 'the store holds an id of 32 hex digits, which names its keychain entries')
  record({ from: 'scenario', note: 'a second start, on the same store' })
  await checkSession(folder, 'data')
  check(storeIdOf(join(folder, 'data')) === first, 'a second start on the same store keeps its id')
  record({ from: 'scenario', note: 'a start on a new store' })
  await checkSession(folder, 'other')
  const other = storeIdOf(join(folder, 'other'))
  check(isId(other) && other !== first, 'a new store gets an id of its own')

  // Opening a store that has its id only reads it, so a writer elsewhere does not hold the
  // program up. The lock goes once the program has answered, before its input closes.
  record({ from: 'scenario', note: 'a start on the same store, while another connection holds its write lock' })
  using writer = new DatabaseSync(join(folder, 'data', 'letterbox.sqlite'))
  writer.exec('begin immediate')
  await checkSession(folder, 'data', () => writer.isTransaction && writer.exec('commit'))
}

const built = spawnSync('cargo', ['build', '--quiet', '--bin', 'letterbox-core'], { cwd: ROOT, stdio: 'inherit' })
if (built.status !== 0) {
  console.log('letterbox-core did not build, so the app host check did not run.')
  process.exit(2)
}

const folder = mkdtempSync(join(tmpdir(), 'letterbox-app-host-'))
try {
  writeFileSync(join(folder, 'client.json'), JSON.stringify(DUMMY_CLIENT))
  writeFileSync(join(folder, 'web-client.json'), JSON.stringify({ web: DUMMY_CLIENT.installed }))
  checkBadArguments(folder)
  await checkStoreIds(folder)
} finally {
  rmSync(folder, { recursive: true, force: true })
}

mkdirSync(ARTIFACTS, { recursive: true })
writeFileSync(
  join(ARTIFACTS, 'letterbox-core.jsonl'),
  `${transcript.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
)
for (const failure of failures) console.log(`FAIL  ${failure}`)
console.log(
  `letterbox-core: ${failures.length === 0 ? 'every check passed' : `${failures.length} checks failed`}. Transcript in artifacts/app-host/.`,
)
process.exit(failures.length === 0 ? 0 : 1)
