// Builds main and the preload into dist/, and finds the Electron binary.
//
//   node apps/desktop/shell/src/build.ts
//
// The build is rolldown, the bundler Vite already uses for the renderer, so the shell adds
// no second toolchain. Two calls bundle both entries in well under a second: main as ES
// modules (main.js, with app.ts split out so Node's compile cache covers it), and the
// preload as one CommonJS file, which is the only kind a sandboxed preload can load.

import { createRequire } from 'node:module'
import { join } from 'node:path'
import { build, type InputOptions } from 'rolldown'

/** The shell package. Electron runs it as an app: its package.json names dist/main.js. */
export const SHELL = join(import.meta.dirname, '..')
const DIST = join(SHELL, 'dist')

/**
 * Bundles main and the preload into dist/. Rejects with the bundler's error. Main goes first:
 * it empties dist/, and rolldown runs an array of builds at once, so a build alongside it could
 * lose its file.
 */
export async function buildShell() {
  const shared = { platform: 'node', external: ['electron'], logLevel: 'warn' } satisfies InputOptions
  await build({
    ...shared,
    input: join(SHELL, 'src/main/main.ts'),
    output: { dir: DIST, format: 'esm', cleanDir: true },
  })
  await build({
    ...shared,
    input: join(SHELL, 'src/preload/preload.ts'),
    output: { file: join(DIST, 'preload.cjs'), format: 'cjs' },
  })
}

/** The Electron binary. The electron package downloads it the first time this is asked. */
export function electronBinary(): string {
  const binary: unknown = createRequire(import.meta.url)('electron')
  if (typeof binary !== 'string') throw new Error('the electron package gave no binary path')
  return binary
}

if (import.meta.main) await buildShell()
