// Makes scenarios open a conversation through the fixtures, which wait for bodies.
//
// Opening a conversation starts a body fetch in the background. A scenario that
// acts before the fetch ends gets a transcript that changes from run to run.
// .oxlintrc.json decides which folders this rule applies to.

import { defineRule, type ESTree } from '@oxlint/plugins'
import { propertyName } from '../ast.ts'

const MESSAGE =
  "Do not subscribe to or query the 'thread' view directly in a scenario. Opening a conversation starts a body fetch, " +
  'and acting before it ends makes the transcript differ between runs. ' +
  'Use openThread or readThread from packages/harness/src/fixtures.ts, which wait until no body is loading. ' +
  'To test a fetch in flight, call holdBodies on the mailbox and use watchThread.'

/** True when an object literal has `view: 'thread'`. */
const opensThread = (node: ESTree.Node | undefined) =>
  node?.type === 'ObjectExpression' &&
  node.properties.some(
    (property) =>
      property.type === 'Property' &&
      !property.computed &&
      property.key.type === 'Identifier' &&
      property.key.name === 'view' &&
      property.value.type === 'Literal' &&
      property.value.value === 'thread',
  )

export default defineRule({
  meta: {
    type: 'problem',
    docs: { description: "Require scenarios to open the 'thread' view through the fixtures." },
  },
  create(context) {
    return {
      CallExpression(node) {
        if (node.callee.type !== 'MemberExpression') return
        const method = propertyName(node.callee)
        if ((method === 'subscribe' || method === 'query') && opensThread(node.arguments[0])) {
          context.report({ node, message: MESSAGE })
        }
      },
    }
  },
})
