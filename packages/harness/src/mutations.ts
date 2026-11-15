// Proves the checks catch real mistakes. Each entry breaks the code one way, runs
// the scenarios that should notice, and puts the file back. Run it with
// `pnpm scenarios:selftest`. It fails if any break goes unnoticed.
//
// Most entries are mistakes an agent made, or nearly made, while this repo was built.
// When a check is added for a new mistake, add the mistake here, so the check is
// proven to fail on it and keeps failing on it.
//
// An entry whose text is no longer in its file fails too. Update the text to match
// the code, so the break still means what its name says.

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

type Mutation = {
  /** What goes wrong, in a user's or a reviewer's words. */
  name: string
  file: string
  /** Text that must appear exactly once in the file. */
  find: string
  replace: string
  /** Runs only the scenarios whose name contains this. */
  scenarios: string
}

const core = (file: string) => `packages/core/src/${file}`

const MUTATIONS: Mutation[] = [
  {
    name: 'a message moved on another device gets a new identity',
    file: core('reconcile.ts'),
    find: '.find((record) => fingerprint(record.facts) === print)',
    replace: '.find(() => false)',
    scenarios: 'keeps its identity',
  },
  {
    name: 'a full resync keeps messages the provider deleted',
    file: core('reconcile.ts'),
    find: '!listed.has(record.ref)) vanished.set',
    replace: 'false) vanished.set',
    scenarios: 'expired cursor',
  },
  {
    name: 'a change set never deletes',
    file: core('reconcile.ts'),
    find: '  for (const ref of incoming.removed) {',
    replace: '  for (const ref of [] as typeof incoming.removed) {',
    scenarios: 'converges',
  },
  {
    name: 'threads ignore the subject and merge unrelated replies',
    file: core('reconcile.ts'),
    find: 'if (record && normalizeSubject(record.facts.subject) === subject)',
    replace: 'if (record)',
    scenarios: 'both the reply chain',
  },
  {
    name: 'threads ignore the reply chain',
    file: core('reconcile.ts'),
    find: '  for (const reference of facts.references) {',
    replace: '  for (const reference of [] as string[]) {',
    scenarios: 'joins the conversation',
  },
  {
    name: 'a pending change does not show until the provider has it',
    file: core('changes.ts'),
    find: 'pending.reduce((state, op) => overlay(state, op, record.id), record.server)',
    replace: '(void pending, record.server)',
    scenarios: 'replay in order',
  },
  {
    name: 'offline changes reach the provider newest first',
    file: core('core.ts'),
    find: '(change) => change.accountId === accountId && change.outcome === null,\n    )',
    replace: '(change) => change.accountId === accountId && change.outcome === null,\n    ).toReversed()',
    scenarios: 'replay in order',
  },
  {
    name: 'settled is sent before the refused change is undone',
    file: core('core.ts'),
    find: "    const rev = commit((tx, at) => putChange(world, tx, { ...change, outcome: { rev: at, result } }))\n    send({ kind: 'settled', change: change.id, rev, result })",
    replace:
      "    send({ kind: 'settled', change: change.id, rev: store.rev() + 1, result })\n    commit((tx, at) => putChange(world, tx, { ...change, outcome: { rev: at, result } }))",
    scenarios: 'refuses is undone',
  },
  {
    name: 'a refused change is reported as done',
    file: core('core.ts'),
    find: "settle(change, refused ? { failed: refused } : 'done')",
    replace: "settle(change, 'done')",
    scenarios: 'refuses is undone',
  },
  {
    name: 'the same change sent twice is applied twice',
    file: core('core.ts'),
    find: '    if (earlier) {',
    replace: '    if (earlier && Number.isNaN(0)) {',
    scenarios: 'same change twice',
  },
  {
    name: 'a read-only account accepts changes',
    file: core('changes.ts'),
    find: "  if (!account.capabilities.modify) return refuse('not-permitted')\n",
    replace: '',
    scenarios: 'read-only account',
  },
  {
    name: 'a folders account is changed as if it had labels',
    file: core('changes.ts'),
    find: "const mode = account.capabilities.multipleMailboxes ? 'sets' : 'move'",
    replace: "const mode = 'sets' as 'sets' | 'move'",
    scenarios: 'archiving takes',
  },
  {
    name: 'mail from a machine counts as my turn',
    file: core('turns.ts'),
    find: "  if (last.automated) return { holder: 'none', reason: 'automated' }\n",
    replace: '',
    scenarios: 'whose turn it is',
  },
  {
    name: 'mail I am only copied on counts as my turn',
    file: core('turns.ts'),
    find: "  if (!last.toMe) return { holder: 'none', reason: 'not-addressed-to-me' }\n",
    replace: '',
    scenarios: 'whose turn it is',
  },
  {
    name: 'a turn the user corrected goes back to the rule',
    file: core('turns.ts'),
    find: "  if (override) return { holder: override, reason: 'set-by-user' }\n",
    replace: '',
    scenarios: 'correction to a turn',
  },
  {
    name: 'a turn correction is never settled',
    file: core('core.ts'),
    find: "      return send({ kind: 'settled', change, rev, result: 'done' })",
    replace: '      return void rev',
    scenarios: 'correction to a turn',
  },
  {
    name: 'the snapshot cursor is not saved, so every sync starts over',
    file: core('core.ts'),
    find: '            removed: [],\n          })\n          putAccount(world, tx, { ...account, cursor: result.cursor })',
    replace: '            removed: [],\n          })\n          putAccount(world, tx, { ...account, cursor: null })',
    scenarios: 'resumes with one cheap call',
  },
  {
    name: 'a second change uses the ref the first change replaced',
    file: core('core.ts'),
    find: 'const ref = outcome.moved.find((pair) => pair.from === record.ref)?.to ?? record.ref',
    replace: 'const ref = record.ref',
    scenarios: 'second change follows',
  },
  {
    name: 'a superseded sign-in is not told so',
    file: core('core.ts'),
    find: '        prior.superseded = true\n',
    replace: '',
    scenarios: 'second sign-in',
  },
  {
    name: 'a client on another protocol version is welcomed',
    file: core('core.ts'),
    find: 'if (message.protocol !== PROTOCOL) {',
    replace: 'if (Number.isNaN(message.protocol)) {',
    scenarios: 'refuses a different protocol',
  },
  {
    name: 'a body is fetched again every time the conversation opens',
    file: core('core.ts'),
    find: 'commit((tx) => putMessage(world, tx, { ...current, body }, current))',
    replace: 'commit(() => void body)',
    scenarios: 'opened, once',
  },
  {
    name: 'a late body for a deleted message is shown as loading forever',
    file: core('core.ts'),
    find: "const body = result.kind === 'body' ? { kind: 'body' as const, body: result.body } : { kind: 'gone' as const }",
    replace: "if (result.kind === 'gone') return\n    const body = { kind: 'body' as const, body: result.body }",
    scenarios: 'deleted while its body loads',
  },
  {
    name: 'a provider ref reaches the UI',
    file: core('views.ts'),
    find: 'snippet: last.facts.preview,',
    replace: 'snippet: last.ref,',
    scenarios: 'first sync shows',
  },
  {
    name: 'the core sends a message outside the protocol',
    file: core('core.ts'),
    find: "    send({ kind: 'settled', change: change.id, rev, result })",
    replace:
      "    send({ kind: 'settled', change: change.id, rev, result: result === 'done' ? ('finished' as 'done') : result })",
    scenarios: 'marking read',
  },
]

const ROOT = join(import.meta.dirname, '..', '..', '..')
const SCRATCH = mkdtempSync(join(tmpdir(), 'letterbox-mutations-'))

/** Applies one mutation, runs its scenarios, restores the file. True when the scenarios failed, as they should. */
function caught(mutation: Mutation): { ok: boolean; why: string } {
  const path = join(ROOT, mutation.file)
  const original = readFileSync(path, 'utf8')
  const count = original.split(mutation.find).length - 1
  if (count !== 1)
    return {
      ok: false,
      why: `its text appears ${count} times in ${mutation.file}. Update the entry to match the code.`,
    }
  writeFileSync(path, original.replace(mutation.find, mutation.replace))
  try {
    const run = spawnSync(process.execPath, ['packages/harness/src/run.ts', mutation.scenarios], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 120_000,
      // Transcripts of broken code go to a throwaway folder, never over the real run's.
      env: { ...process.env, LETTERBOX_ARTIFACTS: SCRATCH },
    })
    const summary = run.stdout.trim().split('\n').at(-1) ?? ''
    return run.status === 0 ? { ok: false, why: `the scenarios still pass: ${summary}` } : { ok: true, why: summary }
  } finally {
    writeFileSync(path, original)
  }
}

let missed = 0
for (const mutation of MUTATIONS) {
  const result = caught(mutation)
  if (!result.ok) missed += 1
  console.log(`${result.ok ? 'caught' : 'MISSED'}  ${mutation.name}${result.ok ? '' : `\n        ${result.why}`}`)
}
console.log(`\n${MUTATIONS.length - missed} of ${MUTATIONS.length} breaks were caught.`)
rmSync(SCRATCH, { recursive: true, force: true })
process.exit(missed === 0 ? 0 : 1)
