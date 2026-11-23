// Breaks in the core's answer to a host saying the network may be back (`network-back`,
// crates/core/src/schedule.rs). mutations.ts runs them with the others. The shell's half
// (apps/desktop/shell/src/main/network.ts) is checked by the Electron check's built run.

import type { Mutation } from './breaks.ts'

const schedule = 'crates/core/src/schedule.rs'

/** What `hint_holds` asks, all of it. Each break below drops one part. */
const HOLDS =
  'pulls.offline && offline && !state.pulls.contains_key(account_id) && !state.backfills.contains_key(account_id)'

export const NETWORK_MUTATIONS: Mutation[] = [
  {
    name: 'a network-back hint reaches no schedule, so an offline account waits out its backoff',
    file: schedule,
    find: '                linked.network.notify_one();',
    replace: '                drop(linked);',
    scenarios: 'network-back hint',
  },
  {
    name: 'a network-back hint pulls an account whose last pull went well, as one a push found offline',
    file: schedule,
    find: HOLDS,
    replace: HOLDS.replace('pulls.offline && ', ''),
    scenarios: 'only a push found',
  },
  {
    name: 'a network-back hint pulls an account that needs a sign-in',
    file: schedule,
    find: HOLDS,
    replace: HOLDS.replace(' && offline &&', ' &&'),
    scenarios: 'while the account needs a sign-in',
  },
  {
    name: 'a network-back hint that comes while a pull is under way brings another',
    file: schedule,
    find: HOLDS,
    replace: HOLDS.replace(' && !state.pulls.contains_key(account_id)', ''),
    scenarios: 'under way is ignored',
  },
  {
    name: 'each hint of a burst starts the settle again, so a flapping network keeps pushing the pull off',
    file: schedule,
    find: '                        if sooner.is_none() {',
    replace: '                        if true {',
    scenarios: 'network-back hint',
  },
  {
    name: 'a network-back hint forgets the failures in a row, so a flapping network keeps the backoff short',
    file: schedule,
    find: '                    Woke::Hinted => {\n',
    replace: '                    Woke::Hinted => {\n                        failures = 0;\n',
    scenarios: 'still offline backs off further',
  },
]
