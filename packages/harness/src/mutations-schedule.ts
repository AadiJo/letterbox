// Breaks in the sync schedule, which pulls on its own while the core runs
// (crates/core/src/schedule.rs). mutations.ts runs them with the others.

import type { Mutation } from './breaks.ts'

const core = (file: string) => `crates/core/src/${file}`

export const SCHEDULE_MUTATIONS: Mutation[] = [
  {
    name: 'a resumed account pulls only when asked, so mail that came while the app was quit waits',
    file: core('lib.rs'),
    find: '            core.inner.schedule(account_id, linked, Duration::ZERO);',
    replace: '            drop((account_id, linked));',
    scenarios: 'pulls the mail that came while it was down',
  },
  {
    name: 'a resumed account waits a whole period before its first pull',
    file: core('lib.rs'),
    find: '            core.inner.schedule(account_id, linked, Duration::ZERO);',
    replace: '            core.inner.schedule(account_id, linked, crate::schedule::PERIOD);',
    scenarios: 'pulls the mail that came while it was down',
  },
  {
    name: 'a signed-in account pulls only when asked, so mail never comes in while the app runs',
    file: core('accounts.rs'),
    find: '        self.schedule(account_id, linked, crate::schedule::PERIOD);',
    replace: '        drop((account_id, linked));',
    scenarios: 'passes a minute',
  },
  {
    name: 'the scheduled pass only pushes, so a reply is never told',
    file: core('schedule.rs'),
    find: 'Rc::clone(self).pass(account_id.clone(), true)',
    replace: 'Rc::clone(self).pass(account_id.clone(), false)',
    scenarios: 'told once, with no sync-now',
  },
  {
    name: 'the schedule queues a pull behind one that is already running',
    file: core('schedule.rs'),
    find: 'let busy = self.state.borrow().pulls.contains_key(&account_id) || self.backfilling(&account_id);',
    replace: 'let busy = self.backfilling(&account_id);',
    scenarios: 'no pull while',
  },
  {
    name: 'the schedule sees only a running pull, and queues one behind a sync-now that waits its turn',
    file: core('schedule.rs'),
    find: 'self.state.borrow().pulls.contains_key(&account_id)',
    replace: 'self.state.borrow().syncing.contains(&account_id)',
    scenarios: 'no pull while',
  },
  {
    name: 'a pull that fails is tried again every period, however long the provider stays down',
    file: core('schedule.rs'),
    find: 'Some(PERIOD.saturating_mul(2_u32.saturating_pow(failures)).min(MOST))',
    replace: 'Some(PERIOD.min(MOST))',
    scenarios: 'backs off',
  },
  {
    name: 'health that clears does not wake the schedule, so mail waits out the backoff',
    file: core('sync.rs'),
    find: '            linked.wake.notify_waiters();',
    replace: '            let _ = linked;',
    scenarios: 'backs off',
  },
  {
    name: 'close leaves each schedule waiting for its next pull, so the core never exits',
    file: core('lib.rs'),
    find: '        self.inner.closing.cancel();\n',
    replace: '',
    scenarios: 'closed while it waits',
  },
]
