// Breaks in undo: what each change records it altered (effect.rs), how an undo answers
// (undo.rs), and the push that must pass a cancelled change by (sync.rs). mutations.ts runs
// them with the core's other breaks.

import type { Mutation } from './breaks.ts'

const core = (file: string) => `crates/core/src/${file}`

export const UNDO_MUTATIONS: Mutation[] = [
  {
    name: 'an undo cancels a change the provider already holds, so the provider keeps it',
    file: core('undo.rs'),
    find: 'if target.outcome.is_none() && !effect.reached() && !in_flight.contains(&target.id) =>',
    replace: 'if true =>',
    scenarios: 'undo after sync reverses',
  },
  {
    name: 'an undo always sends the opposite change, so a change made offline reaches the provider and back',
    file: core('undo.rs'),
    find: 'if target.outcome.is_none() && !effect.reached() && !in_flight.contains(&target.id) =>',
    replace: 'if false =>',
    scenarios: 'undo before sync cancels',
  },
  {
    name: 'an undo that lands while the change is on its way cancels it, though the provider is taking it',
    file: core('undo.rs'),
    find: ' && !in_flight.contains(&target.id) =>',
    replace: ' =>',
    scenarios: 'on its way reverses',
  },
  {
    name: 'a change that reached the provider in part is cancelled, so the provider keeps that part',
    file: core('sync.rs'),
    find: '                            if let Some(reached) = &reached {\n                                put_change(world, tx, reached.clone());\n                            }\n',
    replace: '',
    scenarios: 'part of a change reached',
  },
  {
    name: 'a pass pushes a change an undo cancelled while an earlier change was on its way',
    file: core('sync.rs'),
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
    name: 'an undo overwrites a later change to the same field',
    file: core('effect.rs'),
    find: '        .filter(in_effect)\n',
    replace: '        .filter(|_| false)\n',
    scenarios: 'later change altered the same field',
  },
  {
    name: 'a later change to another field of the message blocks an undo',
    file: core('effect.rs'),
    find: '            || (self.was_unread.is_some() && other.was_unread.is_some())',
    replace: '            || true',
    scenarios: 'later change altered the same field',
  },
  {
    name: 'a change the provider refused can be undone, reversing what never happened',
    file: core('undo.rs'),
    find: 'Some(ChangeResult::Failed(_) | ChangeResult::Undone) = target',
    replace: 'Some(ChangeResult::Undone) = target',
    scenarios: 'provider refused is refused',
  },
  {
    name: 'an undo can be undone',
    file: core('undo.rs'),
    find: '    if target.effect.undoes().is_some() {\n        return Err(Refusal::NotSupported);\n    }\n',
    replace: '',
    scenarios: 'sent twice',
  },
  {
    name: 'a turn correction forgets the turn it replaced, so its undo hands the thread to the rule',
    file: core('effect.rs'),
    find: '                    was,\n                })',
    replace: '                    was: None.filter(|_: &Turn| was.is_some()),\n                })',
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
]
