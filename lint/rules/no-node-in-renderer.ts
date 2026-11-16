// Keeps Node and Electron out of the desktop renderer.
//
// The renderer runs in Electron and, through `pnpm dev`, in a plain browser tab, where a
// coding agent checks the UI against fake mail. Neither has Node, and only one has Electron.
// Bans importing `node:*`, a Node built-in module or `electron`, and reading Node's globals.
// .oxlintrc.json decides which folders this rule applies to.

import { builtinModules } from 'node:module'
import { defineRule, type ESTree } from '@oxlint/plugins'
import { globalName, reportOncePerPosition } from '../ast.ts'

/** Node's globals that browsers lack. */
const NODE_GLOBALS = new Set([
  'process',
  'Buffer',
  'global',
  'require',
  'module',
  'exports',
  '__dirname',
  '__filename',
  'setImmediate',
  'clearImmediate',
])

const BUILTINS = new Set(builtinModules)

const MESSAGE =
  'The renderer also runs in a plain browser (`pnpm dev`), which has no Node and no Electron. ' +
  'Reach the core through @letterbox/client, and read data from its views. ' +
  'Code that needs Node or Electron belongs in the process that hosts the renderer, such as packages/dev-host ' +
  'in the browser loop. Expose what the renderer needs from there, the way `/dev/deliver` backs window.letterboxDev.'

/** True for `node:fs`, `fs`, `fs/promises`, `electron` and `electron/main`. */
const isBanned = (specifier: string) => {
  if (specifier.startsWith('node:') || specifier === 'electron' || specifier.startsWith('electron/')) return true
  return BUILTINS.has(specifier) || BUILTINS.has(specifier.split('/')[0] ?? '')
}

export default defineRule({
  meta: {
    type: 'problem',
    docs: { description: 'Disallow Node and Electron imports and Node globals in the desktop renderer.' },
  },
  create(context) {
    const report = reportOncePerPosition(context)

    const check = (source: ESTree.Expression | null) => {
      if (source?.type === 'Literal' && typeof source.value === 'string' && isBanned(source.value))
        report(source, MESSAGE)
    }

    return {
      ImportDeclaration: (node) => check(node.source),
      ExportNamedDeclaration: (node) => check(node.source),
      ExportAllDeclaration: (node) => check(node.source),
      ImportExpression: (node) => check(node.source),
      TSImportType: (node) => check(node.source),
      // A bare `process` that nothing in the file declares. A local variable of that name is fine.
      'Program:exit'(program) {
        for (const { identifier } of context.sourceCode.getScope(program).through) {
          if (identifier.type === 'Identifier' && NODE_GLOBALS.has(identifier.name)) report(identifier, MESSAGE)
        }
      },
      // `globalThis.process` and `globalThis['Buffer']`.
      MemberExpression(node) {
        const name = globalName(node)
        if (node.object.type === 'Identifier' && name !== undefined && NODE_GLOBALS.has(name)) report(node, MESSAGE)
      },
    }
  },
})
