// Breaks in how long a turn the user sets holds: until a message sent after the newest one
// the conversation had then (turns.rs), as rows, merges (reconcile.rs) and undo (effect.rs)
// read it. mutations.ts runs them with the core's other breaks.

import type { Mutation } from './breaks.ts'

const core = (file: string) => `crates/core/src/${file}`

export const TURN_MUTATIONS: Mutation[] = [
  {
    name: 'a turn the user set holds forever, so their reply to a done conversation goes missing',
    file: core('rows.rs'),
    find: '        held_override(thread, newest),',
    replace: '        thread.turn_override,',
    scenarios: 'done holds until they reply',
  },
  {
    name: 'a turn set holds against the clock when it was set, so a reply dated before then never ends it',
    file: core('turns.rs'),
    find: 'newest_held(world, &thread.id).unwrap_or_default()',
    replace: 'String::from("2026-01-01T00:00:00.000Z")',
    scenarios: 'done holds until they reply',
  },
  {
    name: 'a turn set ends when the last message to arrive changes, so a late older message ends done',
    file: core('rows.rs'),
    find: '    let newest = held.last().map(|record| &record.facts.sent_at);',
    replace:
      '    let newest = world.messages_by_thread.get(thread_id).and_then(|ids| ids.last()).and_then(|id| world.messages.get(id)).map(|record| &record.facts.sent_at);',
    also: [
      {
        file: core('turns.rs'),
        find: '    let moved = newest.is_some_and(|newest| parse(newest) > parse(since));',
        replace: '    let moved = newest.is_some_and(|newest| newest != since);',
      },
    ],
    scenarios: 'arrives late',
  },
  {
    name: 'only their messages end a turn set, so my own reply leaves it done',
    file: core('rows.rs'),
    find: '    let newest = held.last().map(|record| &record.facts.sent_at);',
    replace:
      '    let newest = held.iter().rev().find(|record| !same(&record.facts.from.address, &account.address)).map(|record| &record.facts.sent_at);',
    scenarios: 'a reply of mine ends done',
  },
  {
    name: 'a reply of mine in its undo window ends done before the provider holds it',
    file: core('rows.rs'),
    find: '    let newest = held.last().map(|record| &record.facts.sent_at);',
    replace: '    let newest = records.last().map(|record| &record.facts.sent_at);',
    scenarios: 'still in its undo window',
  },
  {
    name: 'a merge keeps the turn set but not when it was set, so a reply after the merge never ends it',
    file: core('reconcile.rs'),
    find: '                    override_since: lost.override_since,',
    replace: '                    override_since: kept.override_since.clone(),',
    scenarios: 'a merge keeps done',
  },
  {
    name: "a merge keeps the survivor's done though the merged mail ended it, and drops the newer conversation's",
    file: core('reconcile.rs'),
    find: '            && held_override(&kept, newest.as_ref()).is_none()\n            && held_override(&lost, newest.as_ref()).is_some()',
    replace: '            && kept.turn_override.is_none()\n            && lost.turn_override.is_some()',
    scenarios: 'marked done',
  },
  {
    name: 'an undo of a turn change ignores mail that came after it, so undoing a hand-back buries their reply',
    file: core('effect.rs'),
    find: '                    moved || held_override(thread, newest.as_ref()) != altered.now',
    replace: '                    held_override(thread, newest.as_ref()) != altered.now',
    scenarios: 'undoing done after they replied',
  },
  {
    name: 'an undo compares the turn as stored, not as it holds, so undoing done after their reply goes through',
    file: core('effect.rs'),
    find: '                    moved || held_override(thread, newest.as_ref()) != altered.now',
    replace: '                    thread.turn_override != altered.now',
    scenarios: 'undoing done after they replied',
  },
  {
    name: 'a turn change records the turn as stored, so undoing done set again restores the done a reply ended',
    file: core('effect.rs'),
    find: '                let was = held_override(world.threads.get(id)?, newest.as_ref());',
    replace: '                let was = world.threads.get(id)?.turn_override;',
    scenarios: 'done holds until they reply',
  },
]
