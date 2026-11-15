// Keeps timers out of scenarios. A scenario that sleeps hopes the core got somewhere in
// time, so its transcript changes with the machine's speed and a race it should test is
// hidden instead. .oxlintrc.json decides which folders this rule applies to.

import { defineRule } from '@oxlint/plugins'
import { reportOncePerPosition } from '../ast.ts'

/** Timer functions. Checking identifiers covers every spelling: imported, bare or read off globalThis. */
const TIMERS = new Set(['setTimeout', 'setInterval', 'setImmediate'])

const MESSAGE =
  'Do not wait on time in a scenario. Wait on something the core or the sim provider reports: a fixture such as ' +
  'untilAccounts or bodiesSettled, core.inputClosed(), or box.applyHeld(). If nothing reports the moment you need, ' +
  'add a report for it to the sim provider or core-sim. A sleep makes the transcript depend on the machine and ' +
  'hides the race it waits out.'

export default defineRule({
  meta: {
    type: 'problem',
    docs: { description: 'Disallow timers in scenarios.' },
  },
  create(context) {
    const report = reportOncePerPosition(context)
    return {
      Identifier(node) {
        if (TIMERS.has(node.name)) report(node, MESSAGE)
      },
    }
  },
})
