// Breaks in the core's answer to a host saying the network may be back (`network-back`,
// crates/core/src/schedule.rs). mutations.ts runs them with the others. The shell's half
// (apps/desktop/shell/src/main/network.ts) is checked by the Electron check's built run.

import type { Mutation } from './breaks.ts'

const schedule = 'crates/core/src/schedule.rs'

/** What `hint_holds` asks, all of it. Each break below drops one part. */
const HOLDS =
  'pulls.offline && pulls.ended == ended && offline && queued <= own && !state.backfills.contains_key(account_id)'

export const NETWORK_MUTATIONS: Mutation[] = [
  {
    name: 'a network-back hint reaches no schedule, so an offline account waits out its backoff',
    file: schedule,
    find: '            linked.network.notify_waiters();',
    replace: '            let _ = linked;',
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
    name: 'a network-back hint pulls an account that needs a sign-in by the end of its settle',
    file: schedule,
    find: HOLDS,
    replace: HOLDS.replace(' && offline &&', ' &&'),
    scenarios: 'needs a sign-in by the end',
  },
  {
    name: 'a network-back hint that comes while a pull is under way pulls again once that one ends',
    file: schedule,
    find: HOLDS,
    replace: HOLDS.replace('queued <= own', 'true'),
    scenarios: 'under way is ignored',
  },
  {
    name: 'a network-back hint pulls though a pull ended offline during its settle',
    file: schedule,
    find: HOLDS,
    replace: HOLDS.replace('pulls.ended == ended', 'true'),
    scenarios: 'sees a pull end offline',
  },
  {
    name: 'each hint of a burst starts the settle again, so a flapping network keeps pushing the pull off',
    file: schedule,
    find: '                    Woke::Heard if hint.is_none() => {',
    replace: '                    Woke::Heard if true => {',
    scenarios: 'network-back hint',
  },
  {
    name: 'a network-back hint forgets the failures in a row, so a flapping network keeps the backoff short',
    file: schedule,
    find: '                Woke::Pulled(ended) => {\n',
    replace: '                Woke::Pulled(ended) => {\n                    failures = 0;\n',
    scenarios: 'still offline backs off further',
  },
]
