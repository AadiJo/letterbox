// Keeps the renderer on one clock: apps/desktop/renderer/src/clock.ts.
//
// The protocol carries no time. In the dev loop clock.ts reads the sim's fixed --now, so a
// capture of the same mailbox shows the same ages on any day. A component that reads the
// machine's clock itself shows other ages than its neighbours, and its captures drift daily.
// Bans `Date.now`, `new Date()` and `Date()` with no argument, in every file but clock.ts.
// .oxlintrc.json decides which folders this rule applies to.

import { basename } from 'node:path'
import { defineRule } from '@oxlint/plugins'
import { globalName, propertyName, reportOncePerPosition } from '../ast.ts'

const MESSAGE =
  'Read the time from apps/desktop/renderer/src/clock.ts: `useNow()` in a component, `now()` in an event handler. ' +
  "It follows the dev host's fixed time, so ages match the core's and captures stay the same. " +
  '`new Date(value)` with a time you were given is fine.'

export default defineRule({
  meta: {
    type: 'problem',
    docs: { description: "Disallow reading the machine's clock in the renderer outside clock.ts." },
  },
  create(context) {
    if (basename(context.filename) === 'clock.ts') return {}
    const report = reportOncePerPosition(context)
    return {
      // `Date.now()`, and `Date.now` passed along uncalled.
      MemberExpression(node) {
        if (globalName(node.object) === 'Date' && propertyName(node) === 'now') report(node, MESSAGE)
      },
      NewExpression(node) {
        if (globalName(node.callee) === 'Date' && node.arguments.length === 0) report(node, MESSAGE)
      },
      // `Date()` called bare returns the current time as a string.
      CallExpression(node) {
        if (globalName(node.callee) === 'Date') report(node, MESSAGE)
      },
    }
  },
})
