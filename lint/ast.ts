// Syntax-tree helpers that more than one rule needs.

import type { Context, ESTree, Ranged } from '@oxlint/plugins'

/**
 * Wraps `context.report` so that one source position is reported once.
 * Shorthand such as `{ name }` and `import { name }` holds the same identifier twice at
 * one position, and oxlint visits both. Call this once per file, inside `create`.
 */
export const reportOncePerPosition = (context: Context) => {
  const reported = new Set<number>()
  return (node: Ranged, message: string) => {
    const [start] = node.range
    if (reported.has(start)) return
    reported.add(start)
    context.report({ node, message })
  }
}

/**
 * The property a member expression reads: "now" for `Date.now` and for `Date['now']`.
 * Undefined when the key is only known at run time, as in `Date[key]`.
 */
export const propertyName = ({ computed, property }: ESTree.MemberExpression) => {
  if (!computed) return property.type === 'Identifier' ? property.name : undefined
  return property.type === 'Literal' && typeof property.value === 'string' ? property.value : undefined
}

/**
 * The name of the global that `node` refers to, written bare or through globalThis.
 * `Date` and `globalThis.Date` both give "Date". Any other expression gives undefined.
 */
export const globalName = (node: ESTree.Node) => {
  if (node.type === 'Identifier') return node.name
  const viaGlobalThis =
    node.type === 'MemberExpression' && node.object.type === 'Identifier' && node.object.name === 'globalThis'
  return viaGlobalThis ? propertyName(node) : undefined
}
