// Breaks in the core's answer to a host saying the network may be back (`network-back`,
// crates/core/src/schedule.rs). mutations.ts runs them with the others. The shell's half
// (apps/desktop/shell/src/main/network.ts) is checked by the Electron check's built run.

import type { Mutation } from './breaks.ts'

const schedule = 'crates/core/src/schedule.rs'

export const NETWORK_MUTATIONS: Mutation[] = [
  {
    name: 'a network-back hint reaches no schedule, so an offline account waits out its backoff',
    file: schedule,
    find: '            linked.network.notify_waiters();',
    replace: '            let _ = linked;',
    scenarios: 'network-back hint',
  },
  {
    name: 'a network-back hint pulls a healthy account too, so every wake costs a pull',
    file: schedule,
    find: '(wait != Some(SETTLE) && self.offline(&account_id))',
    replace: '(wait != Some(SETTLE))',
    scenarios: 'network-back hint',
  },
  {
    name: 'each hint of a burst starts the settle again, so a flapping network keeps pushing the pull off',
    file: schedule,
    find: '(wait != Some(SETTLE) && self.offline(&account_id))',
    replace: '(self.offline(&account_id))',
    scenarios: 'network-back hint',
  },
  {
    name: 'a network-back hint forgets the failures in a row, so a flapping network keeps the backoff short',
    file: schedule,
    find: '                Woke::NetworkBack => {\n',
    replace: '                Woke::NetworkBack => {\n                    failures = 0;\n',
    scenarios: 'still offline backs off further',
  },
]
