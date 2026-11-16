// Keeps the renderer's scripted motion in apps/desktop/renderer/src/motion.ts.
//
// The approved motion runs once, takes 250 ms or less, moves only transform, opacity and
// height, and is instant under the system's reduced motion setting. motion.ts holds those
// rules for every row. An `element.animate()` written anywhere else skips them, and the
// first loop or spinner that slips in pegs the GPU on a high-refresh display.
// Bans `.animate(...)` calls in every file but motion.ts. CSS animations live in styles.css,
// which clears Tailwind's looping ones. .oxlintrc.json decides which folders this rule applies to.

import { basename } from 'node:path'
import { defineRule } from '@oxlint/plugins'
import { propertyName } from '../ast.ts'

const MESSAGE =
  'Animate rows through apps/desktop/renderer/src/motion.ts (`leave`, `restore`, `shake`), or add a one-shot ' +
  'keyframe to the `--animate-*` tokens in styles.css. Both keep motion under 250 ms and off under reduced motion.'

export default defineRule({
  meta: {
    type: 'problem',
    docs: { description: 'Disallow Element.animate() in the renderer outside motion.ts.' },
  },
  create(context) {
    if (basename(context.filename) === 'motion.ts') return {}
    return {
      CallExpression(node) {
        if (node.callee.type === 'MemberExpression' && propertyName(node.callee) === 'animate')
          context.report({ node, message: MESSAGE })
      },
    }
  },
})
