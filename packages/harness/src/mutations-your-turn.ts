// Breaks in telling the UI which new mail makes it the user's turn (crates/core/src/notify.rs).
// mutations.ts runs them with the others.

import type { Mutation } from './breaks.ts'

const notify = 'crates/core/src/notify.rs'

export const YOUR_TURN_MUTATIONS: Mutation[] = [
  {
    name: 'new mail is told whoever holds the turn, so a newsletter notifies',
    file: notify,
    find: '                if turn.is_none_or(|turn| turn.holder != Turn::Mine || turn.reason != TurnReason::TheyWroteLast) {',
    replace: '                if turn.is_none() {',
    scenarios: 'tells nothing',
  },
  {
    name: 'mail a filter filed away from the inbox notifies',
    file: notify,
    find: ' || !newest.server.mailboxes.iter().any(|id| inbox.contains(id))',
    replace: '',
    scenarios: 'tells nothing',
  },
  {
    name: 'a message moved into the inbox is told as new',
    file: notify,
    find: '                .filter(|id| !arrivals.removed.contains(*id))\n',
    replace: '',
    scenarios: 'tells nothing',
  },
  {
    name: 'a late message that is not the newest in its conversation notifies',
    file: notify,
    find: '                if !new.contains(&&newest.id) ||',
    replace: '                if false ||',
    scenarios: 'tells nothing',
  },
  {
    name: 'a conversation is told once for each new message in it',
    file: notify,
    find: '            for thread_id in threads.keys() {',
    replace:
      '            for thread_id in new.iter().filter_map(|id| world.messages.get(*id)).map(|record| &record.thread_id) {',
    scenarios: 'told once',
  },
  {
    name: 'a reply from a person is never told',
    file: 'crates/core/src/sync.rs',
    find: '            self.tell_your_turns(account_id, arrivals);\n',
    replace: '            drop(arrivals);\n',
    scenarios: 'told once',
  },
  {
    name: 'a restart tells every conversation that became my turn while the app was quit',
    file: notify,
    find: '                .filter(after_start)\n',
    replace: '',
    scenarios: 'a restart catches up',
  },
  {
    name: 'an account that catches up through a snapshot stays quiet for one change set too many',
    file: 'crates/core/src/sync.rs',
    find: '        self.caught_up_by_snapshot(account_id);\n',
    replace: '',
    scenarios: 'a restart catches up',
  },
  {
    name: 'the first change set after a restart tells nothing, so a reply sent after the start is never told',
    file: notify,
    find: '.then(|| catch_up.since.clone())',
    replace: '.then(|| "9999-12-31T00:00:00Z".to_owned())',
    scenarios: 'sent after the start',
  },
]
