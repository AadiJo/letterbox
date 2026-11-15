// Keeps the wall clock, random values and timers out of the core.
//
// The core gets time from the Environment in packages/core/src/clock.ts and record ids
// from the store's nextId. clock.ts is the one exception, and .oxlintrc.json decides
// where this rule applies.

import { defineRule, type Ranged } from '@oxlint/plugins'
import { globalName, propertyName, reportOncePerPosition } from '../ast.ts'

/** Banned under any spelling: bare, as a property (`crypto.randomUUID`) or as an import. */
const BANNED_NAMES = new Set(['randomUUID', 'setTimeout', 'setInterval', 'setImmediate'])

/** Banned as a read of that global, called or not. */
const BANNED_MEMBERS = new Set(['Date.now', 'Math.random', 'performance.now'])

export default defineRule({
  meta: {
    type: 'problem',
    docs: { description: 'Disallow the wall clock, random values and timers in the core.' },
  },
  create(context) {
    const report = reportOncePerPosition(context)

    /** Reports one banned construct. `what` is how the message names it. */
    const ban = (node: Ranged, what: string) =>
      report(
        node,
        `Do not use \`${what}\` in the core. Take the time from the Environment in packages/core/src/clock.ts, ` +
          'passed in as an argument, and a new record id from nextId in packages/core/src/store.ts, ' +
          'so a scenario run produces the same transcript every time. ' +
          'The core never waits by itself. Sync runs when a caller asks for it.',
      )

    return {
      Identifier(node) {
        if (BANNED_NAMES.has(node.name)) ban(node, node.name)
      },
      MemberExpression(node) {
        const member = `${globalName(node.object)}.${propertyName(node)}`
        if (BANNED_MEMBERS.has(member)) ban(node, member)
      },
      // `new Date(value)` only converts a value, so it stays allowed.
      NewExpression(node) {
        if (node.arguments.length === 0 && globalName(node.callee) === 'Date') ban(node, 'new Date()')
      },
    }
  },
})
