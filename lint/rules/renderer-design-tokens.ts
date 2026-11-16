// Keeps the renderer's colors, type sizes and shadows in the @theme of
// apps/desktop/renderer/src/styles.css.
//
// C2 works because every surface, text step and shadow is one of a few tokens. A raw color or
// an off-scale size written into a class or a style looks almost right, and the steps drift.
// Tailwind's own palette, type scale and shadows are cleared there, so a default class such
// as `text-sm` silently does nothing. Bans, in string and template text: hex colors, color
// functions (rgb, hsl, oklch, color-mix), arbitrary font sizes and line heights
// (`text-[13px]`, `leading-[1.4]`), and Tailwind's default type scale.
// .oxlintrc.json decides which folders this rule applies to.

import { defineRule } from '@oxlint/plugins'

const BANNED = [
  {
    pattern: /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|color-mix)\(/i,
    message:
      'Use a color token from the @theme in apps/desktop/renderer/src/styles.css (bg-reader, text-muted, border-line…), ' +
      'or a shadow token (shadow-raised, shadow-float, shadow-well). For a person or a label, use hue.ts with bg-tint ' +
      'and text-tint-fg. If the design needs a new value, add a token there.',
  },
  {
    pattern: /\b(?:text|leading)-\[[\d.]/,
    message:
      'Use a type token from the @theme in apps/desktop/renderer/src/styles.css (text-meta, text-row, text-subject, ' +
      'text-body…). Each carries its line height. If the design needs a new size, add a token there.',
  },
  {
    pattern: /(?:^|[\s:'"`])text-(?:xs|sm|base|lg|[2-9]?xl)\b/,
    message:
      "Tailwind's default type scale is cleared in apps/desktop/renderer/src/styles.css, so this class does nothing. " +
      'Use a type token from its @theme (text-meta, text-row, text-subject, text-body…).',
  },
]

export default defineRule({
  meta: {
    type: 'problem',
    docs: { description: 'Disallow raw colors and off-scale type sizes in the renderer.' },
  },
  create(context) {
    const check = (node: Parameters<typeof context.report>[0]['node'], text: string) => {
      const found = BANNED.find(({ pattern }) => pattern.test(text))
      if (found && node) context.report({ node, message: found.message })
    }
    return {
      Literal(node) {
        if (typeof node.value === 'string') check(node, node.value)
      },
      TemplateElement(node) {
        check(node, node.value.raw)
      },
    }
  },
})
