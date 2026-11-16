// Breaks in undo: what each change records it altered and does (effect.rs), how an undo
// answers (undo.rs), and the push that saves when a change may have reached the provider
// (sync.rs), with the adapters' reading of an apply's answer. mutations.ts runs them with
// the core's other breaks.

import type { Mutation } from './breaks.ts'

const core = (file: string) => `crates/core/src/${file}`

export const UNDO_MUTATIONS: Mutation[] = [
  {
    name: 'an undo cancels a change the provider already holds, so the provider keeps it',
    file: core('undo.rs'),
    find: 'if target.outcome.is_none() && !effect.reached() => Ok(Answer::Cancel),',
    replace: 'if true => Ok(Answer::Cancel),',
    scenarios: 'undo after sync reverses',
  },
  {
    name: 'an undo always sends the opposite change, so a change made offline reaches the provider and back',
    file: core('undo.rs'),
    find: 'if target.outcome.is_none() && !effect.reached() => Ok(Answer::Cancel),',
    replace: 'if false => Ok(Answer::Cancel),',
    scenarios: 'undo before sync cancels',
  },
  {
    name: 'a change counts as reached only once its call answers, so an undo during the call cancels it',
    file: core('push.rs'),
    find: '                change = self.set_reached(change, true);\n',
    replace: '',
    scenarios: 'on its way reverses',
    also: [
      {
        file: core('push.rs'),
        find: '                        known = true;\n',
        replace:
          '                        known = true;\n                        change = self.set_reached(change, true);\n',
      },
    ],
  },
  {
    name: 'a restart during a call forgets the change may have reached the provider, so its undo cancels it',
    file: core('push.rs'),
    find: '                change = self.set_reached(change, true);\n',
    replace: '',
    scenarios: 'a restart during an archive',
    also: [
      {
        file: core('push.rs'),
        find: '                        known = true;\n',
        replace:
          '                        known = true;\n                        change = self.set_reached(change, true);\n',
      },
    ],
  },
  {
    name: 'a lost answer counts as not reached, so the undo cancels a change the provider took',
    file: core('push.rs'),
    find: '                    Ok(ApplyResult::Unconfirmed { failure }) => return Err(failure),',
    replace:
      '                    Ok(ApplyResult::Unconfirmed { failure }) => {\n                        self.set_reached(change, false);\n                        return Err(failure);\n                    }',
    scenarios: 'answer was lost',
  },
  {
    name: 'a call that surely never arrived still counts as reached, so a change that never left goes out and back',
    file: core('push.rs'),
    find: '                        if !known {',
    replace: '                        if false {',
    scenarios: 'cancels a change still waiting',
  },
  {
    name: 'a call that surely never arrived clears reached, though an earlier call of the change landed',
    file: core('push.rs'),
    find: '                        if !known {',
    replace: '                        if true {',
    scenarios: 'part of a change reached',
  },
  {
    name: 'the sim adapter reads a lost apply answer as offline, as if it never arrived',
    file: 'crates/sim-client/src/lib.rs',
    find: '        Box::pin(self.call_untrusted(Call::Apply(mutation), apply_outcome, unconfirmed))',
    replace: '        drop(unconfirmed);\n        Box::pin(self.call(Call::Apply(mutation)))',
    scenarios: 'answer was lost',
  },
  {
    name: 'the gmail adapter reads a lost apply answer as offline, as if it never arrived',
    file: 'crates/gmail/src/adapter.rs',
    find: '            CallError::Lost | CallError::Unreadable => return unconfirmed(failure),',
    replace: '            CallError::Lost | CallError::Unreadable => {}',
    scenarios: 'answer was lost',
  },
  {
    name: 'a pass after an unconfirmed move pushes with refs the move replaced, so the move fails though it happened',
    file: core('sync.rs'),
    find: '        if self.unsure(&account_id) && !self.backfilling(&account_id) {',
    replace: '        if false {',
    scenarios: 'counts it as reached',
  },
  {
    name: 'a pass pushes a change an undo cancelled while an earlier change was on its way',
    file: core('push.rs'),
    find: 'let Some(mut change) = found.filter(|change| change.outcome.is_none()) else {',
    replace: 'let Some(mut change) = found else {',
    scenarios: 'waiting behind another',
  },
  {
    name: 'a cancelled change stays pending, so it still shows and still goes out',
    file: core('undo.rs'),
    find: '                put_change(world, tx, ChangeRecord { outcome, ..target });\n',
    replace: '                drop((outcome, target));\n',
    scenarios: 'undo before sync cancels',
  },
  {
    name: 'undoing an archive puts Inbox back on every message it named, sent and archived mail too',
    file: core('effect.rs'),
    find: '                    removed: before\n                        .mailboxes\n                        .iter()\n                        .filter(|id| !after.mailboxes.contains(id))\n                        .cloned()\n                        .collect(),',
    replace:
      'removed: ops.iter().flat_map(|op| match op { Op::Mailboxes { remove, .. } => remove.clone(), Op::Flags { .. } => vec![] }).collect(),',
    scenarios: 'leaves sent and already archived',
  },
  {
    name: 'a change records the messages it named, not those it altered, so its undo touches the rest',
    file: core('effect.rs'),
    find: '                (!untouched).then_some(altered)',
    replace:
      '                drop(untouched);\n                Some(Altered { was_unread: Some(before.unread), ..altered })',
    scenarios: 'undo after sync reverses',
  },
  {
    name: 'a change carries the Ops it was given, so it does what it never recorded',
    file: core('effect.rs'),
    find: '            ops: ops_for(&altered, mode, false),',
    replace: '            ops: ops.to_vec(),',
    scenarios: 'does only what it recorded',
  },
  {
    name: 'an undo overwrites what changed since, here or at the provider',
    file: core('undo.rs'),
    find: '    if let Some(conflict) = target.effect.conflict(world) {',
    replace: '    if let Some(conflict) = target.effect.conflict(world).filter(|_| false) {',
    scenarios: 'provider changed what',
  },
  {
    name: 'an undo overwrites a later change to the same field on this device',
    file: core('undo.rs'),
    find: '    if let Some(conflict) = target.effect.conflict(world) {',
    replace: '    if let Some(conflict) = target.effect.conflict(world).filter(|_| false) {',
    scenarios: 'later change altered the same field',
  },
  {
    name: 'a flag the change never set counts against its undo, so a later change to it blocks the undo',
    file: core('effect.rs'),
    find: 'was.is_some_and(|was| now.is_none_or(|now| now == was));',
    replace: 'was.is_none() || was.is_some_and(|was| now.is_none_or(|now| now == was));',
    scenarios: 'later change altered the same field',
  },
  {
    name: 'a conversation merged into another is passed over, so its undo of done reverses nothing',
    file: core('effect.rs'),
    find: '                    now.is_none_or(|thread| thread.turn_override != altered.now)',
    replace: '                    now.is_some_and(|thread| thread.turn_override != altered.now)',
    scenarios: 'merge moved',
  },
  {
    name: 'an undo puts a message back in a mailbox that was deleted',
    file: core('effect.rs'),
    find: '        if let Some(gone) = restored.into_iter().find(|id| !world.mailboxes.contains_key(*id)) {',
    replace: '        if let Some(gone) = restored.into_iter().find(|_| false) {',
    scenarios: 'deleted mailbox',
  },
  {
    name: 'a change whose undo altered nothing can be undone again under a new id',
    file: core('undo.rs'),
    find: '    if undone(world, &target.id) {',
    replace: '    if undone(world, &target.id) && false {',
    scenarios: 'undone once, even',
  },
  {
    name: 'a change fails when the messages of one of its steps are gone, though the others took it',
    file: core('push.rs'),
    find: '                    }) => gone += 1,',
    replace:
      '                    }) => {\n                        gone += 1;\n                        refused = Some(ProviderRefusal::UnknownTarget);\n                        break;\n                    }',
    scenarios: 'need different steps',
  },
  {
    name: 'a trash on a labels account takes Sent off, which Gmail never does, so its undo is refused after a sync',
    file: core('changes.rs'),
    find: '                mode == MailboxMode::Sets && matches!(mailbox.role, Some(Role::Sent | Role::Drafts))',
    replace: '                mode == MailboxMode::Sets && matches!(mailbox.role, Some(Role::Drafts))',
    scenarios: 'leaves sent and already archived',
  },
  {
    name: 'a change the provider refused can be undone, reversing what never happened',
    file: core('undo.rs'),
    find: '        Some(ChangeResult::Failed(_)) if !reached => return refuse(Refusal::Conflict),',
    replace: '        Some(ChangeResult::Failed(_)) if false => return refuse(Refusal::Conflict),',
    scenarios: 'provider refused is refused',
  },
  {
    name: 'an undo can be undone',
    file: core('undo.rs'),
    find: '    if target.effect.undoes().is_some() {\n        return refuse(Refusal::NotSupported);\n    }\n',
    replace: '',
    scenarios: 'sent twice',
  },
  {
    name: 'a turn correction forgets the turn it replaced, so its undo hands the thread to the rule',
    file: core('effect.rs'),
    find: '                    was,\n                    now: *value,',
    replace: '                    was: None.filter(|_: &Turn| was.is_some()),\n                    now: *value,',
    scenarios: 'turn the user set',
  },
  {
    name: 'an undo lives only in memory, so a restart before it reaches the provider loses it',
    file: core('world.rs'),
    find: "pub fn put_change(world: &mut World, tx: &Transaction<'_>, record: ChangeRecord) {\n    tx.put(&record);",
    replace:
      "pub fn put_change(world: &mut World, tx: &Transaction<'_>, record: ChangeRecord) {\n    if record.effect.undoes().is_none() {\n        tx.put(&record);\n    }",
    scenarios: 'accepted before a restart',
  },
  {
    name: 'a lost move goes again before the refresh that shows where it went has ended',
    file: core('sync.rs'),
    find: '            let refreshed = !self.unsure(&account_id) || matches!(pulled, Some(Pulled::Done));',
    replace: '            let refreshed = true;',
    scenarios: 'lost move waits',
  },
  {
    name: 'a change on the messages of a held change goes ahead of it, so an undo outruns its change',
    file: core('push.rs'),
    find: '            if !refreshed && (was_reached || change.effect.named().any(|id| held.contains(id))) {',
    replace: '            if !refreshed && was_reached {',
    scenarios: 'lost move waits',
  },
  {
    name: 'the sim answers a deleted mailbox as messages gone, so a step it turns away counts as done',
    file: 'packages/sim-provider/src/mailbox.ts',
    find: "    if (add === undefined || remove === undefined) return refused('unknown-mailbox')",
    replace: "    if (add === undefined || remove === undefined) return refused('unknown-target')",
    scenarios: 'names a mailbox deleted',
  },
  {
    name: 'a step that names a missing mailbox counts as gone, so the change settles done',
    file: core('push.rs'),
    find: '                        reason: ProviderRefusal::UnknownTarget,\n',
    replace: '                        reason: ProviderRefusal::UnknownTarget | ProviderRefusal::UnknownMailbox,\n',
    scenarios: 'names a mailbox deleted',
  },
  {
    name: 'gmail forgets that an earlier request of a step went through when a later one is turned away',
    file: 'crates/gmail/src/adapter.rs',
    find: '        let refused = |reason| Ok(ApplyResult::Refused { reason, landed });',
    replace: '        let refused = |reason| Ok(ApplyResult::Refused { reason, landed: landed && false });',
    scenarios: 'earlier request of it went through',
  },
  {
    name: 'a step turned away after part of it went through still shows as never sent, so its undo puts nothing back',
    file: core('push.rs'),
    find: '                            self.lay_over(&step.message_ids, &step.part, &[]);\n',
    replace: '',
    scenarios: 'earlier request of it went through',
  },
  {
    name: 'a change turned away after one of its steps went through cannot be undone, so that step stays',
    file: core('undo.rs'),
    find: '        Some(ChangeResult::Failed(_)) if !reached => return refuse(Refusal::Conflict),',
    replace: '        Some(ChangeResult::Failed(_)) => return refuse(Refusal::Conflict),',
    scenarios: 'turned away after one of its steps',
  },
  {
    name: 'a failed change keeps the steps that never went through, so its undo is refused over them',
    file: core('push.rs'),
    find: '            self.settle(\n                failed_in_part(change, &applied, &partly),\n                ChangeResult::Failed(reason.into()),\n            );',
    replace:
      '            drop((applied, partly));\n            self.settle(change, ChangeResult::Failed(reason.into()));',
    scenarios: 'turned away after one of its steps',
  },
]
