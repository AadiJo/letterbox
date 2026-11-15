// Keeps prints out of the core and the protocol.
//
// Bans every use of `console` and of `process.stdout` and `process.stderr`.
// .oxlintrc.json decides which folders this rule applies to.

import { defineRule } from '@oxlint/plugins'
import { globalName, propertyName, reportOncePerPosition } from '../ast.ts'

const MESSAGE =
  'Do not print from the core or the protocol. Stdout carries the protocol, one JSON message per line, so a stray print corrupts the stream for every client. ' +
  'Report a problem as a protocol message, or pass diagnostics to the log function the core is given.'

export default defineRule({
  meta: {
    type: 'problem',
    docs: { description: 'Disallow console and the process output streams in the core and the protocol.' },
  },
  create(context) {
    const report = reportOncePerPosition(context)
    return {
      // Any mention of `console` counts: a call, `globalThis.console`, or `const { log } = console`.
      Identifier(node) {
        if (node.name === 'console') report(node, MESSAGE)
      },
      MemberExpression(node) {
        const stream = propertyName(node)
        if (globalName(node.object) === 'process' && (stream === 'stdout' || stream === 'stderr')) report(node, MESSAGE)
      },
    }
  },
})
