// Keeps the renderer's colors, type sizes and shadows in the @theme of
// apps/desktop/renderer/src/styles.css.
//
// C2 works because every surface, text step and shadow is one of a few tokens. A raw color or
// an off-scale size written into a class or a style looks almost right, and the steps drift.
// Tailwind's own palette, type scale and shadows are cleared there, so a default class such
// as `text-sm` silently does nothing.
//
// Only styling is read, never other text, so "Issue #123" or '{"ticket":"#123"}' are fine:
//   - class lists: a `className` attribute or property, and every argument of `cx` (cx.ts).
//     Arbitrary colors in any color-bearing utility (`bg-[#111]`, `border-l-[red]`), arbitrary
//     type sizes (`text-[19px]`, `text-[length:19px]`, `leading-[1.4]`) and shadows
//     (`shadow-[0_1px_2px_black]`), arbitrary color, type and shadow properties
//     (`[border-top-color:red]`), and Tailwind's default palette and type scale. A length or
//     size, such as `bg-[length:200px_100px]` or `ring-[1.5px]`, is not a color.
//   - inline styles: color, type and shadow properties in a `style` prop or `.style.x = …`
//   - CSS in a string (`<style>…`): raw colors
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
  'shadow-well, shadow-outline, shadow-band), or add one there.'
const DEFAULTS =
  "Tailwind's default palette and type scale are cleared in apps/desktop/renderer/src/styles.css, so this class " +
  'does nothing. Use a token from its @theme (text-row, text-muted, bg-reader…).'
const STYLE =
  'Set colors, type and shadows with a class from the @theme in apps/desktop/renderer/src/styles.css, not an ' +
  'inline style. A person or a label gets its color from hue.ts `tint`.'

const RAW_COLOR = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb|color-mix)\(/i
const PALETTE =
  'slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose'
/** Utilities that take a color. Type (`text`, `leading`) and shadows have rules of their own below. */
const COLOR_FAMILY =
  'bg|border(?:-[xytrblse])?|ring|ring-offset|inset-ring|outline|divide|decoration|accent|caret|fill|stroke|from|via|to|placeholder'
const SHADOW_FAMILY = 'shadow|inset-shadow|drop-shadow|text-shadow'
/** Arbitrary values that are lengths, sizes, positions or images, not colors. */
const NOT_A_COLOR = /^(?:[\d.-]|length:|size:|position:|percentage:|number:|image:|url\(|var\(--)/

/** An arbitrary value made only of tokens: `var(--…)`, transparent, currentColor, inherit or none. */
const ONLY_TOKENS = (value: string) =>
  value.split('_').every((part) => /^(?:var\(--[\w-]+\)|transparent|currentColor|inherit|none)$/.test(part))

/** Inline style and arbitrary properties that carry color, type or a shadow, and which message fits. */
const propertyMessage = (name: string) => {
  if (/color$/i.test(name) || /^(?:background|fill|stroke)$/i.test(name)) return COLOR
  if (/^(?:font|font-?size|line-?height)$/i.test(name)) return TYPE
  if (/^(?:box|text)-?shadow$/i.test(name)) return SHADOW
  return null
}

/** The utility a class names, without its variants (`hover:`, `wide:`) or `!`. Colons inside [] are not variants. */
function utilityOf(token: string) {
  let depth = 0
  let start = 0
  for (const [index, char] of [...token].entries()) {
    if (char === '[') depth += 1
    else if (char === ']') depth -= 1
    else if (char === ':' && depth === 0) start = index + 1
  }
  return token.slice(start).replace(/^!|!$/g, '').replace(/^-/, '')
}

/** What one class does wrong, if anything. */
function classMessage(token: string) {
  const utility = utilityOf(token)
  const property = /^\[([a-z-]+):(.+)\]$/i.exec(utility)
  if (property?.[1] && property[2]) {
    const message = propertyMessage(property[1])
    return message && !ONLY_TOKENS(property[2]) ? message : null
  }
  if (/^(?:text|leading)-\[/.test(utility)) return TYPE
  if (new RegExp(`^(?:${SHADOW_FAMILY})-\\[`).test(utility)) return SHADOW
  const arbitrary = new RegExp(`^(?:${COLOR_FAMILY})-\\[([^\\]]*)\\]`).exec(utility)
  if (arbitrary) return NOT_A_COLOR.test(arbitrary[1] ?? '') && !RAW_COLOR.test(arbitrary[1] ?? '') ? null : COLOR
  if (/^text-(?:xs|sm|base|lg|[2-9]?xl)(?:\/|$)/.test(utility)) return DEFAULTS
  const palette = `(?:white|black|(?:${PALETTE})-\\d{2,3})(?:\\/|$)`
  if (new RegExp(`^(?:${COLOR_FAMILY}|text|${SHADOW_FAMILY})-${palette}`).test(utility)) return DEFAULTS
  return null
}

const keyName = (key: ESTree.Node) =>
  key.type === 'Identifier' ? key.name : key.type === 'Literal' && typeof key.value === 'string' ? key.value : null

/** Whether a value found in the syntax tree is a node: an object with a string `type`. */
const isNode = (value: unknown): value is ESTree.Node =>
  typeof value === 'object' && value !== null && 'type' in value && typeof value.type === 'string'

/** Calls `visit` on every node under `node`, itself included. */
function walk(node: unknown, visit: (node: ESTree.Node) => void) {
  if (Array.isArray(node)) return node.forEach((child) => walk(child, visit))
  if (!isNode(node)) return
  visit(node)
  for (const [key, child] of Object.entries(node)) if (key !== 'parent') walk(child, visit)
}

export default defineRule({
  meta: {
    type: 'problem',
    docs: { description: 'Disallow raw colors, off-scale type sizes and raw shadows in the renderer.' },
  },
  create(context) {
    /** Reads every class in every string under `node`, once per string. */
    const checkClasses = (root: ESTree.Node) =>
      walk(root, (node) => {
        const text =
          node.type === 'Literal' && typeof node.value === 'string'
            ? node.value
            : node.type === 'TemplateElement'
              ? node.value.raw
              : null
        if (text === null) return
        const message = text
          .split(/\s+/)
          .map(classMessage)
          .find((found) => found !== null)
        if (message) context.report({ node, message })
      })
    const checkStyle = (object: ESTree.Node) => {
      if (object.type !== 'ObjectExpression') return
      for (const property of object.properties)
        if (property.type === 'Property' && propertyMessage(keyName(property.key) ?? ''))
          context.report({ node: property, message: STYLE })
    }
    return {
      JSXAttribute(node) {
        if (node.name.type !== 'JSXIdentifier' || !node.value) return
        if (node.name.name === 'className' || node.name.name === 'class') checkClasses(node.value)
        else if (node.name.name === 'style' && node.value.type === 'JSXExpressionContainer')
          checkStyle(node.value.expression)
      },
      Property(node) {
        if (keyName(node.key) === 'className') checkClasses(node.value)
      },
      CallExpression(node) {
        if (node.callee.type === 'Identifier' && node.callee.name === 'cx') node.arguments.forEach(checkClasses)
      },
      // `element.style.color = …`
      AssignmentExpression(node) {
        const { left } = node
        if (
          left.type === 'MemberExpression' &&
          left.object.type === 'MemberExpression' &&
          left.object.property.type === 'Identifier' &&
          left.object.property.name === 'style' &&
          propertyMessage(keyName(left.property) ?? '')
        )
          context.report({ node, message: STYLE })
      },
      // CSS written into a string, such as a frame's own <style>.
      Literal(node) {
        if (typeof node.value === 'string' && /<style\b/i.test(node.value) && RAW_COLOR.test(node.value))
          context.report({ node, message: COLOR })
      },
    }
  },
})
