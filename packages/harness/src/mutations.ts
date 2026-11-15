// Proves the checks catch real mistakes. Each entry breaks the code one way, runs
// the scenarios that should notice, and puts the files back. Run it with
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

type Edit = {
  file: string
  /** Text that must appear exactly once in the file. */
  find: string
  replace: string
}

type Mutation = Edit & {
  /** What goes wrong, in a user's or a reviewer's words. */
  name: string
  /** Runs only the scenarios whose name contains this. */
  scenarios: string
  /** More edits, for a break that needs more than one place changed. Applied in order after the first. */
  also?: Edit[]
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
    find: 'match self.by_message.get(&record.id) {',
    replace: 'match self.by_message.get(&record.id).filter(|_| false) {',
    scenarios: 'replay in order',
  },
  {
    name: 'offline changes reach the provider newest first',
    file: core('sync.rs'),
    find: '        for change in waiting {\n            if !self.still_current(account_id, linked) {',
    replace:
      '        for change in waiting.into_iter().rev() {\n            if !self.still_current(account_id, linked) {',
    scenarios: 'replay in order',
  },
  {
    name: 'settled is sent before the refused change is undone',
    file: core('sync.rs'),
    find: '        let id = change.id.clone();\n        let rev = self.commit(',
    replace:
      '        let id = change.id.clone();\n        let early = self.store.rev() + 1;\n        self.send(CoreMessage::Settled { change: id.clone(), rev: early, result });\n        let rev = self.commit(',
    scenarios: 'refuses is undone',
  },
  {
    name: 'a refused change is reported as done',
    file: core('sync.rs'),
    find: 'refused.map_or(ChangeResult::Done, |reason| ChangeResult::Failed(reason.into()))',
    replace: 'refused.map_or(ChangeResult::Done, |_| ChangeResult::Done)',
    scenarios: 'refuses is undone',
  },
  {
    name: 'the same change sent twice is applied twice',
    file: core('dispatch.rs'),
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
    file: core('dispatch.rs'),
    find: '            return self.send(CoreMessage::Settled {\n                change,\n                rev,\n                result: ChangeResult::Done,\n            });',
    replace: '            return drop((change, rev));',
    scenarios: 'correction to a turn',
  },
  {
    name: 'the snapshot cursor is not saved, so every sync starts over',
    file: core('sync.rs'),
    find: '                        cursor: result.cursor,',
    replace: '                        cursor: result.cursor.filter(|_| false),',
    scenarios: 'resumes with one cheap call',
  },
  {
    name: 'a second change uses the ref the first change replaced',
    file: core('sync.rs'),
    find: '.find(|pair| pair.from == record.r#ref)',
    replace: '.find(|_| false)',
    scenarios: 'second change follows',
  },
  {
    name: 'a superseded sign-in is not told so',
    file: core('sign_in.rs'),
    find: '        (false, answer) => Outcome::Superseded(answer.ok()),',
    replace:
      '        (false, Ok(connection)) => Outcome::SignedIn(connection),\n        (false, Err(failure)) => Outcome::Failed(failure),',
    scenarios: 'second sign-in',
  },
  {
    name: 'a client on another protocol version is welcomed',
    file: core('dispatch.rs'),
    find: 'if protocol != f64::from(PROTOCOL) {',
    replace: 'if protocol.is_nan() {',
    scenarios: 'refuses a different protocol',
  },
  {
    name: 'a body is fetched again every time the conversation opens',
    file: core('sync.rs'),
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
    file: core('sync.rs'),
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
    name: 'a push that outlives its sign-out still writes what it learned',
    file: core('sync.rs'),
    find: '.is_some_and(|current| current.link == linked.link)',
    replace: '.is_some_and(|current| current.link == linked.link) || linked.link > 0',
    scenarios: 'a sign-out that',
  },
  {
    name: 'a sign-out that deletes mail leaves its waiting changes unsettled',
    file: core('accounts.rs'),
    find: '            self.send(CoreMessage::Settled { change, rev, result });\n',
    replace: '            drop((change, rev, result));\n',
    scenarios: 'deletes mail settles',
  },
  {
    name: 'closing the core waits forever on a sign-in the user never finishes',
    file: core('lib.rs'),
    find: '        self.inner.state.borrow().attempts.cancel_all();\n',
    replace: '',
    scenarios: 'answered cancelled when the core stops',
  },
  {
    name: 'a sign-out waits behind the work already queued for the account',
    file: core('accounts.rs'),
    find: '    pub(crate) fn sign_out(self: &Rc<Self>, id: RequestId, account_id: AccountId, delete_local_mail: bool) {\n',
    replace: [
      '    pub(crate) fn sign_out(self: &Rc<Self>, id: RequestId, account_id: AccountId, delete_local_mail: bool) {',
      '        let core = Rc::clone(self);',
      '        let queue = account_id.clone();',
      '        self.background(&queue, async move { core.sign_out_now(id, account_id, delete_local_mail) });',
      '    }',
      '',
      '    fn sign_out_now(self: &Rc<Self>, id: RequestId, account_id: AccountId, delete_local_mail: bool) {',
      '',
    ].join('\n'),
    scenarios: 'sign-out is answered while',
  },
  {
    name: 'closing the core does not wait for the work in flight',
    file: core('lib.rs'),
    find: '        self.inner.work.wait().await;\n',
    replace: '',
    scenarios: 'saved before it exits',
  },
  {
    name: 'the mailbox filter reads what the provider holds and misses pending changes',
    file: core('views.rs'),
    find: 'records().any(|record| pending.view_state(record).mailboxes.contains(mailbox))',
    replace: 'records().any(|record| record.server.mailboxes.contains(mailbox))',
    scenarios: 'each list filter agrees',
  },
  {
    name: 'the session goes back into the account record',
    file: core('world.rs'),
    find: '    pub signed_in: bool,\n',
    replace: '    pub signed_in: bool,\n    pub session: String,\n',
    also: [
      {
        file: core('accounts.rs'),
        find: '                    signed_in: true,\n',
        replace: '                    signed_in: true,\n                    session: connection.session.clone(),\n',
      },
    ],
    scenarios: 'first sync shows',
  },
  {
    name: 'a sign-out leaves the session in the keychain',
    file: core('accounts.rs'),
    find: '        let _ = self.secrets.delete(&account_id);\n',
    replace: '',
    scenarios: 'until a sign-out deletes it',
  },
  {
    name: 'a sign-in links the account when the keychain refuses its session',
    file: core('accounts.rs'),
    find: 'if self.secrets.write(&account_id, &connection.session).is_err() {',
    replace: 'if self.secrets.write(&account_id, &connection.session).is_err() && false {',
    scenarios: 'locked keychain',
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
  {
    name: 'the client hands a wait for one change the settled of another',
    file: 'packages/client/src/client.ts',
    find: "message.kind === 'settled' && message.change === change",
    replace: "message.kind === 'settled'",
    scenarios: 'replay in order',
  },
]

const ROOT = join(import.meta.dirname, '..', '..', '..')
const SCRATCH = mkdtempSync(join(tmpdir(), 'letterbox-mutations-'))

/** Applies one mutation, runs its scenarios, restores the files. True when the scenarios failed, as they should. */
function caught(mutation: Mutation): { ok: boolean; why: string } {
  // Each file's text before the first edit to it, to put back afterwards.
  const originals = new Map<string, string>()
  const restore = () => {
    for (const [path, text] of originals) writeFileSync(path, text)
  }
  for (const edit of [mutation, ...(mutation.also ?? [])]) {
    const path = join(ROOT, edit.file)
    const text = readFileSync(path, 'utf8')
    if (!originals.has(path)) originals.set(path, text)
    const count = text.split(edit.find).length - 1
    if (count !== 1) {
      restore()
      return {
        ok: false,
        why: `its text appears ${count} times in ${edit.file}. Update the entry to match the code.`,
      }
    }
    writeFileSync(path, text.replace(edit.find, edit.replace))
  }
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
    restore()
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
