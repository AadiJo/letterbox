// Keeps conversation lists in apps/desktop/renderer/src/threads.ts.
//
// A list there holds ids, and each row reads its own record with `useThread(id)`, so a
// change to one conversation re-renders one row. A component that subscribes to the
// threads view itself gets every row in one value, and re-renders all of them on any change.
// Bans a `{ view: 'threads' }` query in every renderer file but threads.ts.
// .oxlintrc.json decides which folders this rule applies to.

import { basename } from 'node:path'
import { defineRule } from '@oxlint/plugins'

const MESSAGE =
  'Subscribe to conversation lists only through apps/desktop/renderer/src/threads.ts: `useThreadWindow` for a long list, ' +
  '`useThreadSection` for a short one. Render each row from its id with `useThread(id)`, so one changed conversation re-renders one row.'

export default defineRule({
  meta: {
    type: 'problem',
    docs: { description: 'Disallow threads-view queries in the renderer outside threads.ts.' },
  },
  create(context) {
    if (basename(context.filename) === 'threads.ts') return {}
    return {
      Property(node) {
        const key = node.key.type === 'Identifier' ? node.key.name : node.key.type === 'Literal' ? node.key.value : null
        if (key === 'view' && node.value.type === 'Literal' && node.value.value === 'threads')
          context.report({ node, message: MESSAGE })
      },
    }
  },
})
