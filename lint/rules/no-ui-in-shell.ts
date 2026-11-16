// Keeps React and the renderer out of the desktop shell.
//
// The shell (apps/desktop/shell) hosts the renderer: it owns the processes and the window,
// and hands the page a port to the core. The page's UI lives in apps/desktop/renderer, which
// also runs in a plain browser without the shell. Bans importing React, React DOM, the
// renderer package, or a relative path into apps/desktop/renderer.
// .oxlintrc.json decides which folders this rule applies to.

import { dirname, relative, resolve, sep } from 'node:path'
import { defineRule, type ESTree } from '@oxlint/plugins'

const ROOT = resolve(import.meta.dirname, '../..')
const RENDERER = ['apps', 'desktop', 'renderer'].join(sep)

const MESSAGE =
  'The desktop shell hosts the renderer and stays out of its UI. Put UI code in apps/desktop/renderer. ' +
  'The page reaches the shell only through window.letterbox, which src/preload/preload.ts sets up, ' +
  'and the type both sides share is ShellBridge in @letterbox/client/message-port.'

/** True for react, react-dom and the renderer package, with or without a subpath. */
const isUiPackage = (specifier: string) => /^(?:react|react-dom|@letterbox\/desktop-renderer)(?:\/|$)/.test(specifier)

export default defineRule({
  meta: {
    type: 'problem',
    docs: { description: 'Disallow React and renderer imports in the desktop shell.' },
  },
  create(context) {
    const folder = dirname(context.filename)

    /** True when a relative `specifier` ends inside apps/desktop/renderer. */
    const intoRenderer = (specifier: string) => {
      if (!/^\.\.?(?:\/|$)/.test(specifier)) return false
      const fromRoot = relative(ROOT, resolve(folder, specifier))
      return fromRoot === RENDERER || fromRoot.startsWith(`${RENDERER}${sep}`)
    }

    const check = (source: ESTree.Expression | null) => {
      if (source?.type !== 'Literal' || typeof source.value !== 'string') return
      if (isUiPackage(source.value) || intoRenderer(source.value)) context.report({ node: source, message: MESSAGE })
    }

    return {
      ImportDeclaration: (node) => check(node.source),
      ExportNamedDeclaration: (node) => check(node.source),
      ExportAllDeclaration: (node) => check(node.source),
      ImportExpression: (node) => check(node.source),
      TSImportType: (node) => check(node.source),
    }
  },
})
