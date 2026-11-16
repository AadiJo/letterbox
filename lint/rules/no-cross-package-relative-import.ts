// Stops a relative import from leaving the package it is in.
//
// A package is the nearest folder, at or above the file, that has a package.json. Packages
// reach each other by name, so the `dependencies` in each package.json stay the one
// place that says who may depend on whom.

import { existsSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { defineRule, type ESTree } from '@oxlint/plugins'

const MESSAGE =
  "This relative path leaves the package the file is in. Import another package by its name, for example '@letterbox/core/adapter'. " +
  'If that name does not resolve, the package is not allowed to depend on it. ' +
  'Allowed directions: protocol depends on nothing, client on protocol, sim-provider on protocol, ' +
  'harness and dev-host on client, protocol and sim-provider, and the desktop renderer on client and protocol.'

/** The nearest folder at or above `folder` that has a package.json, or undefined above the last one. */
const packageRootOf = (folder: string): string | undefined => {
  if (existsSync(join(folder, 'package.json'))) return folder
  const parent = dirname(folder)
  return parent === folder ? undefined : packageRootOf(parent)
}

export default defineRule({
  meta: {
    type: 'problem',
    docs: { description: 'Disallow relative imports that leave the package.' },
  },
  create(context) {
    const folder = dirname(context.filename)
    const packageRoot = packageRootOf(folder)

    /** Reports `source` when it is a string literal with a relative path that ends outside the package. */
    const check = (source: ESTree.Expression | null) => {
      if (packageRoot === undefined || source?.type !== 'Literal' || typeof source.value !== 'string') return
      if (!/^\.\.?(?:\/|$)/.test(source.value)) return
      const fromRoot = relative(packageRoot, resolve(folder, source.value))
      if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`)) context.report({ node: source, message: MESSAGE })
    }

    return {
      ImportDeclaration: (node) => check(node.source),
      ExportNamedDeclaration: (node) => check(node.source),
      ExportAllDeclaration: (node) => check(node.source),
      // `await import('../x.ts')` and the type `import('../x.ts').Name`.
      ImportExpression: (node) => check(node.source),
      TSImportType: (node) => check(node.source),
    }
  },
})
