// Keeps the renderer's colors, type sizes and shadows in the @theme of
// apps/desktop/renderer/src/styles.css.
//
// C2 works because every surface, text step and shadow is one of a few tokens. A raw color or
// an off-scale size written into a class or a style looks almost right, and the steps drift.
// Tailwind's own palette, type scale and shadows are cleared there, so a default class such
// as `text-sm` silently does nothing. Only styling is checked, so text such as "Issue #123"
// or a link to "#abc" is fine:
//   - Tailwind utilities, in any string: arbitrary colors, type sizes and shadows
//     (`bg-[#111]`, `text-[length:19px]`, `shadow-[0_1px_2px_black]`, `[color:red]`), and
//     Tailwind's default palette and type scale (`text-red-500`, `text-sm`)
//   - inline styles: color, type and shadow properties in a `style` prop or `.style.x = …`
//   - HTML or CSS in a string (`<style>`, `style="…"`): raw colors
// .oxlintrc.json decides which folders this rule applies to.

import { defineRule, type ESTree } from '@oxlint/plugins'

const COLOR =
  'Use a color token from the @theme in apps/desktop/renderer/src/styles.css (bg-reader, text-muted, border-line…). ' +
  'For a person or a label, use hue.ts with bg-tint and text-tint-fg. If the design needs a new color, add a token there.'
const TYPE =
  'Use a type token from the @theme in apps/desktop/renderer/src/styles.css (text-meta, text-row, text-subject, ' +
  'text-body…). Each carries its line height. If the design needs a new size, add a token there.'
const SHADOW =
  'Use a shadow token from the @theme in apps/desktop/renderer/src/styles.css (shadow-raised, shadow-float, ' +
  'shadow-well, shadow-outline), or add one there.'
const DEFAULTS =
  "Tailwind's default palette and type scale are cleared in apps/desktop/renderer/src/styles.css, so this class " +
  'does nothing. Use a token from its @theme (text-row, text-muted, bg-reader…).'
const STYLE =
  'Set colors, type and shadows with a class from the @theme in apps/desktop/renderer/src/styles.css, not an ' +
  'inline style. A person or a label gets its color from hue.ts `tint`.'

const RAW_COLOR = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch|color-mix)\(/i
const PALETTE =
  'slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose'
const COLOR_UTILITY =
  'bg|text|border|ring|inset-ring|outline|divide|from|via|to|fill|stroke|shadow|caret|placeholder|decoration|accent'

/** What a single utility class does wrong, if anything. Variants such as `hover:` come before the last colon. */
const TOKEN_RULES: { pattern: RegExp; message: string }[] = [
  // Inside any arbitrary value or property: a raw color.
  { pattern: new RegExp(`\\[[^\\]]*(?:${RAW_COLOR.source})`, 'i'), message: COLOR },
  { pattern: /(?:^|:)(?:text|leading)-\[/, message: TYPE },
  { pattern: /(?:^|:)shadow-\[/, message: SHADOW },
  { pattern: /(?:^|:)(?:bg|from|via|to|fill|stroke|caret|placeholder|decoration|accent)-\[/, message: COLOR },
  // Borders, rings and outlines may take an arbitrary width, never a color.
  { pattern: /(?:^|:)(?:border|ring|inset-ring|outline|divide)(?:-[trblxy])?-\[(?!\d|length:)/, message: COLOR },
  {
    pattern: /(?:^|:)\[(?:color|background(?:-color)?|border-color|outline-color|fill|stroke)(?::|\])/,
    message: COLOR,
  },
  { pattern: /(?:^|:)\[(?:font-size|line-height|font)(?::|\])/, message: TYPE },
  { pattern: /(?:^|:)\[(?:box-shadow|text-shadow)(?::|\])/, message: SHADOW },
  { pattern: /(?:^|:)text-(?:xs|sm|base|lg|[2-9]?xl)$/, message: DEFAULTS },
  {
    pattern: new RegExp(`(?:^|:)(?:${COLOR_UTILITY})-(?:white|black|(?:${PALETTE})-\\d{2,3})(?:/|$)`),
    message: DEFAULTS,
  },
]

/** Inline style properties that carry color, type or a shadow. */
const STYLE_KEYS = new Set([
  'color',
  'background',
  'backgroundColor',
  'backgroundImage',
  'borderColor',
  'outlineColor',
  'caretColor',
  'fill',
  'stroke',
  'boxShadow',
  'textShadow',
  'font',
  'fontSize',
  'lineHeight',
])

/** HTML or CSS in a string, whose colors the rule reads. */
const MARKUP = /<style\b|\bstyle\s*=\s*["']|\{[^{}]*:[^{}]*\}/

const keyName = (key: ESTree.Node) =>
  key.type === 'Identifier' ? key.name : key.type === 'Literal' && typeof key.value === 'string' ? key.value : null

export default defineRule({
  meta: {
    type: 'problem',
    docs: { description: 'Disallow raw colors, off-scale type sizes and raw shadows in the renderer.' },
  },
  create(context) {
    const checkText = (node: ESTree.Node, text: string) => {
      if (MARKUP.test(text) && RAW_COLOR.test(text)) return context.report({ node, message: COLOR })
      for (const token of text.split(/\s+/)) {
        const found = TOKEN_RULES.find(({ pattern }) => pattern.test(token))
        if (found) return context.report({ node, message: found.message })
      }
    }
    const checkStyle = (object: ESTree.Node) => {
      if (object.type !== 'ObjectExpression') return
      for (const property of object.properties)
        if (property.type === 'Property' && STYLE_KEYS.has(keyName(property.key) ?? ''))
          context.report({ node: property, message: STYLE })
    }
    return {
      Literal(node) {
        if (typeof node.value === 'string') checkText(node, node.value)
      },
      TemplateElement(node) {
        checkText(node, node.value.raw)
      },
      JSXAttribute(node) {
        if (
          node.name.type === 'JSXIdentifier' &&
          node.name.name === 'style' &&
          node.value?.type === 'JSXExpressionContainer'
        )
          checkStyle(node.value.expression)
      },
      // `element.style.color = …`
      AssignmentExpression(node) {
        const { left } = node
        if (
          left.type === 'MemberExpression' &&
          left.object.type === 'MemberExpression' &&
          left.object.property.type === 'Identifier' &&
          left.object.property.name === 'style' &&
          STYLE_KEYS.has(keyName(left.property) ?? '')
        )
          context.report({ node, message: STYLE })
      },
    }
  },
})
