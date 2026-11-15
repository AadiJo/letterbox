// Proves the checks catch real mistakes. Each entry breaks the code one way, runs
// the scenarios that should notice, and puts the file back. Run it with
// `pnpm scenarios:selftest`. It fails if any break goes unnoticed.
//
// Most entries are mistakes an agent made, or nearly made, while this repo was built.
// When a check is added for a new mistake, add the mistake here, so the check is
// proven to fail on it and keeps failing on it.
//
// An entry whose text is no longer in its file fails too, and so does one whose break
// no longer compiles. Update the text to match the code, so the break still means what
// its name says. run.ts rebuilds the Rust core before each run, so each break costs a
// short incremental build.

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CORE_DID_NOT_BUILD } from './client.ts'

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

const core = (file: string) => `crates/core/src/${file}`

const MUTATIONS: Mutation[] = [
  {
    name: 'a message moved on another device gets a new identity',
    file: core('reconcile.rs'),
    find: '.find(|record| fingerprint(&record.facts) == print)',
    replace: '.find(|_| false)',
    scenarios: 'keeps its identity',
  },
  {
    name: 'a full resync keeps messages the provider deleted',
    file: core('reconcile.rs'),
    find: 'if &record.account_id == account_id && !listed.contains(&record.r#ref) {',
    replace: 'if &record.account_id == account_id && listed.is_empty() && false {',
    scenarios: 'expired cursor',
  },
  {
    name: 'a change set never deletes',
    file: core('reconcile.rs'),
    find: '    for r#ref in &incoming.removed {',
    replace: '    for r#ref in &Vec::<MessageRef>::new() {',
    scenarios: 'converges',
  },
  {
    name: 'threads ignore the subject and merge unrelated replies',
    file: core('reconcile.rs'),
    find: '.filter(|record| normalize_subject(&record.facts.subject) == subject)',
    replace: '.filter(|_| !subject.is_empty() || subject.is_empty())',
    scenarios: 'both the reply chain',
  },
  {
    name: 'threads ignore the reply chain',
    file: core('reconcile.rs'),
    find: '    for reference in &facts.references {',
    replace: '    for reference in &Vec::<String>::new() {',
    scenarios: 'joins the conversation',
  },
  {
    name: 'a pending change does not show until the provider has it',
    file: core('changes.rs'),
    find: '    pending\n        .iter()\n        .fold(record.server.clone(), |state, op| overlay(&state, op, &record.id))',
    replace: '    let _ = pending;\n    record.server.clone()',
    scenarios: 'replay in order',
  },
  {
    name: 'offline changes reach the provider newest first',
    file: core('lib.rs'),
    find: '        for change in waiting {',
    replace: '        for change in waiting.into_iter().rev() {',
    scenarios: 'replay in order',
  },
  {
    name: 'settled is sent before the refused change is undone',
    file: core('lib.rs'),
    find: '        let id = change.id.clone();\n        let rev = self.commit(',
    replace:
      '        let id = change.id.clone();\n        let early = self.store.rev() + 1;\n        self.send(CoreMessage::Settled { change: id.clone(), rev: early, result });\n        let rev = self.commit(',
    scenarios: 'refuses is undone',
  },
  {
    name: 'a refused change is reported as done',
    file: core('lib.rs'),
    find: 'refused.map_or(ChangeResult::Done, |reason| ChangeResult::Failed(reason.into()))',
    replace: 'refused.map_or(ChangeResult::Done, |_| ChangeResult::Done)',
    scenarios: 'refuses is undone',
  },
  {
    name: 'the same change sent twice is applied twice',
    file: core('lib.rs'),
    find: '        if let Some(earlier) = earlier {',
    replace: '        if let Some(earlier) = earlier.filter(|_| false) {',
    scenarios: 'same change twice',
  },
  {
    name: 'a read-only account accepts changes',
    file: core('changes.rs'),
    find: '    if !account.capabilities.modify {\n        return Err(Refusal::NotPermitted);\n    }\n',
    replace: '',
    scenarios: 'read-only account',
  },
  {
    name: 'a folders account is changed as if it had labels',
    file: core('changes.rs'),
    find: '    let mode = if account.capabilities.multiple_mailboxes {',
    replace: '    let mode = if account.capabilities.multiple_mailboxes || account.capabilities.modify {',
    scenarios: 'archiving takes',
  },
  {
    name: 'mail from a machine counts as my turn',
    file: core('turns.rs'),
    find: '    if last.automated {\n        return decided(Turn::Nobody, TurnReason::Automated);\n    }\n',
    replace: '',
    scenarios: 'whose turn it is',
  },
  {
    name: 'mail I am only copied on counts as my turn',
    file: core('turns.rs'),
    find: '    if !last.to_me {\n        return decided(Turn::Nobody, TurnReason::NotAddressedToMe);\n    }\n',
    replace: '',
    scenarios: 'whose turn it is',
  },
  {
    name: 'a turn the user corrected goes back to the rule',
    file: core('turns.rs'),
    find: '    if let Some(holder) = turn_override {',
    replace: '    if let Some(holder) = turn_override.filter(|_| false) {',
    scenarios: 'correction to a turn',
  },
  {
    name: 'a turn correction is never settled',
    file: core('lib.rs'),
    find: '            return self.send(CoreMessage::Settled {\n                change,\n                rev,\n                result: ChangeResult::Done,\n            });',
    replace: '            return drop((change, rev));',
    scenarios: 'correction to a turn',
  },
  {
    name: 'the snapshot cursor is not saved, so every sync starts over',
    file: core('lib.rs'),
    find: '                        cursor: result.cursor,',
    replace: '                        cursor: result.cursor.filter(|_| false),',
    scenarios: 'resumes with one cheap call',
  },
  {
    name: 'a second change uses the ref the first change replaced',
    file: core('lib.rs'),
    find: '.find(|pair| pair.from == record.r#ref)',
    replace: '.find(|_| false)',
    scenarios: 'second change follows',
  },
  {
    name: 'a superseded sign-in is not told so',
    file: core('lib.rs'),
    find: '            prior.superseded.set(true);\n',
    replace: '',
    scenarios: 'second sign-in',
  },
  {
    name: 'a client on another protocol version is welcomed',
    file: core('lib.rs'),
    find: 'if protocol != f64::from(PROTOCOL) {',
    replace: 'if protocol.is_nan() {',
    scenarios: 'refuses a different protocol',
  },
  {
    name: 'a body is fetched again every time the conversation opens',
    file: core('lib.rs'),
    find: [
      '            Ok(body) => {',
      '                self.commit(|world, tx, _| {',
      '                    put_message(',
      '                        world,',
      '                        tx,',
      '                        MessageRecord {',
      '                            body: Some(body),',
      '                            ..current',
      '                        },',
      '                    );',
      '                });',
      '            }',
    ].join('\n'),
    replace:
      '            Ok(body) => {\n                drop((body, current));\n                self.commit(|_, _, _| {});\n            }',
    scenarios: 'opened, once',
  },
  {
    name: 'a late body for a deleted message is shown as loading forever',
    file: core('lib.rs'),
    find: '            Ok(body) => {\n',
    replace: '            Ok(crate::adapter::BodyResult::Gone) => {}\n            Ok(body) => {\n',
    scenarios: 'deleted while its body loads',
  },
  {
    name: 'the core program stops without closing the core',
    file: 'crates/sim-client/src/main.rs',
    find: '        core.close().await;\n',
    replace: '        drop(core);\n',
    scenarios: 'saved before it exits',
  },
  {
    name: 'closing the core does not wait for the work in flight',
    file: core('lib.rs'),
    find: '        self.inner.work.wait().await;\n',
    replace: '',
    scenarios: 'saved before it exits',
  },
  {
    name: 'a provider ref reaches the UI',
    file: core('views.rs'),
    find: 'snippet: last.facts.preview.clone(),',
    replace: 'snippet: last.r#ref.as_str().to_owned(),',
    scenarios: 'first sync shows',
  },
  {
    name: 'the core sends a message outside the protocol',
    file: 'crates/protocol/src/lib.rs',
    find: 'pub enum ChangeResult {\n    Done,',
    replace: 'pub enum ChangeResult {\n    #[serde(rename = "finished")]\n    Done,',
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
    if (run.status === CORE_DID_NOT_BUILD)
      return { ok: false, why: `the broken code does not compile. Update the entry so it builds.\n${run.stderr}` }
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
