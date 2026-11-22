// Breaks in telling a UI where a conversation sits in a list (`position` in
// crates/core/src/live_view.rs). mutations.ts runs them with the others.

import type { Mutation } from './breaks.ts'

const liveView = 'crates/core/src/live_view.rs'

export const POSITION_MUTATIONS: Mutation[] = [
  {
    name: 'a position ignores the retired cut, so Let go? counts Your turn rows before its own',
    file: liveView,
    find: '        (Some(true), Some(cut)) => at >= cut,\n        (Some(false), Some(cut)) => at < cut,\n',
    replace: '',
    scenarios: 'position says',
  },
  {
    name: 'a position breaks a tie in time by nothing, so two conversations share a place',
    file: liveView,
    find: '.filter(|at| shown(at) && *at < target)',
    replace: '.filter(|at| shown(at) && at.0 < target.0)',
    scenarios: 'position says',
  },
  {
    name: 'a position counts every conversation before it, whatever the filter',
    file: liveView,
    find: '            matches(listed, filter)\n        })\n        .map(|listed| place(&listed.summary))\n        .filter(|at| shown(at)',
    replace:
      '            true\n        })\n        .map(|listed| place(&listed.summary))\n        .filter(|at| shown(at)',
    scenarios: 'position says',
  },
]
