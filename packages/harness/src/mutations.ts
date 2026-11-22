// Proves the checks catch real mistakes. Each entry breaks the code one way, runs
// the scenarios that should notice, and puts the files back. Run it with
// `pnpm scenarios:selftest`. It fails if any break goes unnoticed. A break counts as
// caught at the first scenario run that fails, so the rest are skipped.
// `pnpm scenarios:selftest --shard 2/4` runs only every fourth break, starting at the
// second. CI runs the shards as parallel jobs.
//
// Most entries are mistakes an agent made, or nearly made, while this repo was built.
// When a check is added for a new mistake, add the mistake here, so the check is
// proven to fail on it and keeps failing on it.
//
// An entry whose text is no longer in its file fails too, and so does one whose break
// no longer compiles. Update the text to match the code, so the break still means what
// its name says. run.ts rebuilds the Rust core before each run, so each break costs a
// short incremental build.

import { type Mutation, runBreaks } from './breaks.ts'
import { FORWARD_MUTATIONS } from './mutations-forward.ts'
import { YOUR_TURN_MUTATIONS } from './mutations-your-turn.ts'
import { GMAIL_MUTATIONS } from './mutations-gmail.ts'
import { PEOPLE_MUTATIONS } from './mutations-people.ts'
import { SEND_MUTATIONS } from './mutations-send.ts'
import { TURN_MUTATIONS } from './mutations-turns.ts'
import { UNDO_MUTATIONS } from './mutations-undo.ts'

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
    find: '        .filter(|record| &record.account_id == account_id && record.round != round)\n        .map(',
    replace: '        .filter(|_| false)\n        .map(',
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
    file: core('push.rs'),
    find: '        for id in waiting {\n            if !self.still_current(account_id, linked) {',
    replace: '        for id in waiting.into_iter().rev() {\n            if !self.still_current(account_id, linked) {',
    scenarios: 'replay in order',
  },
  {
    name: 'settled is sent before the refused change is undone',
    file: core('push.rs'),
    find: '        let id = change.id.clone();\n        let rev = self.commit(',
    replace:
      '        let id = change.id.clone();\n        let early = self.store.rev() + 1;\n        self.send(CoreMessage::Settled { change: id.clone(), rev: early, result });\n        let rev = self.commit(',
    scenarios: 'refuses is undone',
  },
  {
    name: 'a refused change is reported as done',
    file: core('push.rs'),
    find: '            let result = refused.map_or(ChangeResult::Done, |reason| ChangeResult::Failed(reason.into()));',
    replace: '            let result = refused.map_or(ChangeResult::Done, |_| ChangeResult::Done);',
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
    find: '    if account.capabilities.multiple_mailboxes {\n        MailboxMode::Sets',
    replace:
      '    if account.capabilities.multiple_mailboxes || account.capabilities.modify {\n        MailboxMode::Sets',
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
    find: '        );\n        self.send(CoreMessage::Settled {\n            change,\n            rev,\n            result: ChangeResult::Done,\n        });',
    replace: '        );\n        drop((change, rev));',
    scenarios: 'correction to a turn',
  },
  {
    name: 'the snapshot cursor is not saved, so every sync starts over',
    file: core('snapshot.rs'),
    find: '                    cursor: page.cursor,',
    replace: '                    cursor: page.cursor.filter(|_| false),',
    scenarios: 'resumes with one cheap call',
  },
  {
    name: 'snapshot pages reach the store only with the last one, so a failure loses the pages before it',
    file: core('snapshot.rs'),
    find: '                added: page.messages,\n',
    replace: '                added: page.messages.into_iter().filter(|_| last).collect(),\n',
    scenarios: 'failure in the middle',
  },
  {
    name: 'snapshot progress lives only in memory, so a restart starts the snapshot over',
    file: core('world.rs'),
    find: '    #[serde(default)]\n    pub snapshot: Option<SnapshotProgress>,',
    replace: '    #[serde(default, skip)]\n    pub snapshot: Option<SnapshotProgress>,',
    scenarios: 'restart in the middle',
  },
  {
    name: 'a snapshot removes the mail it has not listed yet after every page',
    file: core('snapshot.rs'),
    find: '            if last {\n                remove_unlisted(',
    replace: '            if true {\n                remove_unlisted(',
    scenarios: 'removes deleted mail only once',
  },
  {
    name: 'a backfill holds the queue, so a change waits for the whole snapshot',
    file: core('snapshot.rs'),
    find: '        self.queue_next_page(account_id);\n        Ok(Pulled::More)\n',
    replace: '        Box::pin(self.snapshot_page(account_id, linked)).await\n',
    scenarios: 'change made during a backfill',
  },
  {
    name: 'a rejected page token ends the sync instead of starting the snapshot over',
    file: core('snapshot.rs'),
    find: 'Err(AdapterFailure::PageExpired) if progress.next.is_some() =>',
    replace: 'Err(AdapterFailure::PageExpired) if false =>',
    scenarios: 'no longer accepts',
  },
  {
    name: 'a second change uses the ref the first change replaced',
    file: core('push.rs'),
    find: '.find(|pair| pair.from == old)',
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
    file: 'crates/host/src/lib.rs',
    find: '    core.close().await;\n',
    replace: '    drop(core);\n',
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
    name: 'a sync-now that resumes a saved snapshot answers without the changes made before it',
    file: core('sync.rs'),
    find: '                        (_, Some(Ok(()))) => pass = start(&core, account_id.clone()).1,\n',
    replace: '',
    scenarios: 'resumes a saved snapshot',
  },
  {
    name: 'a sync-now that resumes only the last snapshot page answers without the changes made before it',
    file: core('sync.rs'),
    find: '                        (Some(Ok(())), None) if resumed => pass = start(&core, account_id.clone()).1,\n',
    replace: '',
    scenarios: 'resumes only the last',
  },
  {
    name: 'a sync-now loops forever for an account signed out in the middle of a backfill',
    file: core('sync.rs'),
    find: 'state.adapters.contains_key(&account_id) && account',
    replace: 'account',
    scenarios: 'keeps the mail of an unfinished',
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
    name: 'closing the core waits out a gmail rate limit, so it does not exit for minutes',
    file: core('lib.rs'),
    find: '            linked.adapter.stop_waiting();\n',
    replace: '',
    scenarios: 'stop during a rate-limit wait',
  },
  {
    name: 'closing the core closes the adapters first, so work queued behind a call fails offline',
    file: core('lib.rs'),
    find: '            linked.adapter.stop_waiting();\n',
    replace:
      '            let adapter = Rc::clone(&linked.adapter);\n            tokio::task::spawn_local(async move { adapter.close().await });\n',
    scenarios: 'saved before it exits',
  },
  {
    name: 'an open list keeps a thread after it leaves the filter',
    file: core('live_view.rs'),
    find: 'moved |= listed.remove(&place(&before.summary));',
    replace: 'moved |= listed.contains(&place(&before.summary));',
    scenarios: 'open list follows',
  },
  {
    name: 'a pending change does not mark its threads, so open lists show them unchanged',
    file: core('world.rs'),
    find: '    touch_effect(&mut world.touched, &world.messages, Some(&record.effect));\n    world.changes.0.insert',
    replace: '    world.changes.0.insert',
    scenarios: 'each list filter agrees',
  },
  {
    name: 'an open conversation shows a body loading after the fetch failed',
    file: core('live_view.rs'),
    find: 'touched || loading_changed',
    replace: 'touched',
    scenarios: 'cannot load offline',
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
    // SQLite's checkpoint at close overwrites the page, so only a check made while the core runs sees it.
    name: 'the session sits in the account record until the first sync overwrites it',
    file: core('world.rs'),
    find: '    pub signed_in: bool,\n',
    replace: '    pub signed_in: bool,\n    pub session: String,\n',
    also: [
      {
        file: core('accounts.rs'),
        find: '                    signed_in: true,\n',
        replace: '                    signed_in: true,\n                    session: connection.session.clone(),\n',
      },
      {
        file: core('sync.rs'),
        find: '                        health,\n                        last_synced_at,\n                        ..account\n',
        replace:
          '                        health,\n                        last_synced_at,\n                        session: String::new(),\n                        ..account\n',
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
    file: core('rows.rs'),
    find: 'snippet: last.facts.preview.clone(),',
    replace: 'snippet: last.provider_ref().map_or_else(String::new, |r#ref| r#ref.as_str().to_owned()),',
    scenarios: 'first sync shows',
  },
  {
    name: 'the core sends a message outside the protocol',
    file: 'crates/protocol/src/outcome.rs',
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

await runBreaks([
  ...MUTATIONS,
  ...SEND_MUTATIONS,
  ...UNDO_MUTATIONS,
  ...GMAIL_MUTATIONS,
  ...PEOPLE_MUTATIONS,
  ...TURN_MUTATIONS,
  ...FORWARD_MUTATIONS,
  ...YOUR_TURN_MUTATIONS,
])
