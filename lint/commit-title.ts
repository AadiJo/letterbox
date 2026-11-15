// Checks a commit message, or a pull request title, against this repo's commit rules:
// one line, a conventional type in lowercase, a description that starts in lowercase,
// and no co-author trailer. A squash merge turns the PR title into the commit on main.
//
//   node lint/commit-title.ts --file <message file>   the commit-msg hook
//   node lint/commit-title.ts --title "<title>"       CI, for the pull request title
//   node lint/commit-title.ts --selftest              the cases below, run by `pnpm lint:selftest`
//
// Ways this check could be wrong. Each has a case in CASES:
//   - it accepts a message with a body, or with a trailer on a later line
//   - it accepts a Co-authored-by trailer, in any casing
//   - it accepts a type outside the conventional list, or a type or scope with capitals
//   - it accepts a description that starts with a capital letter
//   - it rejects a valid message: with or without a scope, with `!`, or with GitHub's "(#12)"
//   - it reads git's comment lines (starting with #) as part of the message

import { readFileSync } from 'node:fs'

const TYPES = ['feat', 'fix', 'perf', 'refactor', 'test', 'docs', 'build', 'ci', 'chore', 'style', 'revert']
const CONVENTIONAL = new RegExp(`^(${TYPES.join('|')})(\\([a-z0-9-]+\\))?!?: (.+)$`)

/** What is wrong with a commit message, or null when it follows the rules. */
export function problemWith(message: string): string | null {
  const lines = message
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line !== '' && !line.startsWith('#'))
  if (lines.some((line) => /^co-authored-by:/i.test(line))) {
    return 'Remove the Co-authored-by trailer. Commits here name no co-author, human or AI.'
  }
  const [title, ...rest] = lines
  if (title === undefined) return 'The message is empty.'
  if (rest.length > 0) return 'Write the whole message on one line, with no body and no trailers.'
  const description = CONVENTIONAL.exec(title)?.[3]
  if (description === undefined) {
    return `Start with a lowercase conventional type, like "feat: ..." or "fix(core): ...". Types: ${TYPES.join(', ')}.`
  }
  if (/^[A-Z]/.test(description)) return 'Start the description in lowercase.'
  return null
}

/** [message, expected to pass] */
const CASES: [string, boolean][] = [
  ['feat: replace the typescript core with a rust core\n', true],
  ['fix(core): stop a pass from writing after sign-out\n', true],
  ['feat!: drop protocol version 0', true],
  ['fix: end provider calls on sign-out (#12)', true],
  ['# Please enter the commit message\nperf: speed up view updates\n# Lines starting with # are ignored\n', true],
  ['feat: add a thing\n\nA body that explains it.\n', false],
  ['feat: add a thing\nCo-authored-by: Someone <someone@example.com>\n', false],
  ['feat: add a thing\n\nco-authored-by: Claude <noreply@anthropic.com>', false],
  ['Feat: add a thing', false],
  ['feat(Core): add a thing', false],
  ['feature: add a thing', false],
  ['feat: Add a thing', false],
  ['add a thing', false],
  ['', false],
]

const [mode, value] = process.argv.slice(2)
if (mode === '--selftest') {
  const wrong = CASES.filter(([message, passes]) => (problemWith(message) === null) !== passes)
  for (const [message, passes] of wrong) console.log(`expected ${passes ? 'pass' : 'fail'}: ${JSON.stringify(message)}`)
  console.log(
    wrong.length === 0 ? `The commit check passes its ${CASES.length} cases.` : `${wrong.length} cases failed.`,
  )
  process.exit(wrong.length === 0 ? 0 : 1)
}
if ((mode !== '--file' && mode !== '--title') || value === undefined) {
  console.error('usage: node lint/commit-title.ts --file <message file> | --title "<title>" | --selftest')
  process.exit(2)
}
const message = mode === '--file' ? readFileSync(value, 'utf8') : value
const problem = problemWith(message)
if (problem !== null) {
  console.error(
    `${mode === '--file' ? 'commit message' : 'pull request title'}: ${problem}\n  ${message.split('\n')[0]}`,
  )
  process.exit(1)
}
