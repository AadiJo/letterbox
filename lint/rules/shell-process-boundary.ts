// Keeps the desktop shell's main process and its preload apart.
//
// Main (src/main/) runs in Node. The preload (src/preload/) runs sandboxed next to the page,
// bundled into one file on its own. Neither can load the other's modules, so a relative
// import from one folder into the other is banned. What both need to agree on lives in
// src/shared/ as types, imported with `import type`, so no value crosses over.
//
// A file's side is the nearest folder above it, inside the repo, named main, preload or shared.
// .oxlintrc.json decides which folders this rule applies to.

import { dirname, relative, resolve, sep } from 'node:path'
import { defineRule, type ESTree } from '@oxlint/plugins'

type Side = 'main' | 'preload' | 'shared'

const ROOT = resolve(import.meta.dirname, '../..')

const CROSSING =
  "Main and the preload run in different processes, so neither can load the other's modules. " +
  'Share only types: put them in src/shared/ and import them with `import type`. ' +
  'A value both need, such as an IPC channel name, is written on each side and checked with `satisfies` against a shared type.'

const SHARED_VALUE =
  'src/shared/ holds types only, because main and the preload are bundled apart and run in different processes. ' +
  'Import it with `import type`, and write the value on each side, checked with `satisfies` against the shared type.'

/** The nearest folder at or above `folder`, below the repo root, named main, preload or shared. */
const sideOf = (folder: string): Side | undefined =>
  relative(ROOT, folder)
    .split(sep)
    .toReversed()
    .find((part): part is Side => part === 'main' || part === 'preload' || part === 'shared')

export default defineRule({
  meta: {
    type: 'problem',
    docs: { description: "Disallow imports between the shell's main and preload, and value imports from shared." },
  },
  create(context) {
    const folder = dirname(context.filename)
    const own = sideOf(folder)

    /** Reports `source` when it crosses sides, or takes a value from shared. */
    const check = (source: ESTree.Expression | null, typeOnly: boolean) => {
      if (own === undefined || source?.type !== 'Literal' || typeof source.value !== 'string') return
      if (!/^\.\.?(?:\/|$)/.test(source.value)) return
      const target = sideOf(dirname(resolve(folder, source.value)))
      if (target === undefined || target === own) return
      if (target === 'shared') {
        if (!typeOnly) context.report({ node: source, message: SHARED_VALUE })
      } else if (own !== 'shared') {
        context.report({ node: source, message: CROSSING })
      }
    }

    return {
      ImportDeclaration: (node) =>
        check(
          node.source,
          node.importKind === 'type' ||
            (node.specifiers.length > 0 &&
              node.specifiers.every(
                (specifier) => specifier.type === 'ImportSpecifier' && specifier.importKind === 'type',
              )),
        ),
      ExportNamedDeclaration: (node) => check(node.source, node.exportKind === 'type'),
      ExportAllDeclaration: (node) => check(node.source, node.exportKind === 'type'),
      ImportExpression: (node) => check(node.source, false),
      TSImportType: (node) => check(node.source, true),
    }
  },
})
