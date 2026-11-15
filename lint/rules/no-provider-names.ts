// Keeps provider vocabulary out of the core and the protocol.
//
// Checks identifiers, string literals and template literals. Comments may name a
// provider. .oxlintrc.json decides which folders this rule applies to.

import { defineRule, type Ranged } from '@oxlint/plugins'
import { reportOncePerPosition } from '../ast.ts'

/**
 * Provider names, plus two prefixes that only one provider uses for its labels and
 * headers. "googlemail" and "protonmail" are listed because each is one word, so the
 * whole-word match on "google" and "proton" does not see them.
 */
const TERMS =
  'gmail google googlemail imap jmap outlook exchange microsoft yahoo icloud fastmail proton protonmail category_ x-gm-'
    .split(' ')
    .map((term) => new RegExp(term, 'gi'))

/**
 * True when a word can start or end between text[index - 1] and text[index].
 * That is at either end of the text, next to anything that is not a letter, at a
 * camelCase hump ("gmail|Label") and after an acronym ("IMAP|Client").
 */
const isWordBoundary = (text: string, index: number) => {
  const before = text[index - 1]
  const after = text[index]
  if (before === undefined || after === undefined) return true
  if (!/[a-z]/i.test(before) || !/[a-z]/i.test(after)) return true
  if (/[a-z]/.test(before) && /[A-Z]/.test(after)) return true
  return /[A-Z]/.test(before) && /[A-Z]/.test(after) && /[a-z]/.test(text[index + 1] ?? '')
}

/** The first term that stands in `text` as a whole word: "imap" in "imapUid", but not in "minimap". */
const providerTermIn = (text: string) => {
  for (const term of TERMS) {
    for (const { 0: found, index } of text.matchAll(term)) {
      if (isWordBoundary(text, index) && isWordBoundary(text, index + found.length)) return found
    }
  }
  return undefined
}

export default defineRule({
  meta: {
    type: 'problem',
    docs: { description: 'Disallow provider names in the core and the protocol.' },
  },
  create(context) {
    const report = reportOncePerPosition(context)

    /** Reports `node` when `text` names a provider. */
    const check = (node: Ranged, text: string) => {
      const term = providerTermIn(text)
      if (term === undefined) return
      report(
        node,
        `"${term}" is provider vocabulary. The core and the protocol must behave the same for every provider, so do not name one here. ` +
          'If behaviour differs between providers, add a field to AdapterCapabilities in packages/core/src/adapter.ts and branch on it. ' +
          'If a provider knows a fact the core needs, add it to RemoteFacts and let the adapter fill it in.',
      )
    }

    return {
      Identifier: (node) => check(node, node.name),
      PrivateIdentifier: (node) => check(node, node.name),
      Literal(node) {
        if (typeof node.value === 'string') check(node, node.value)
      },
      TemplateElement: (node) => check(node, node.value.cooked ?? node.value.raw),
    }
  },
})
