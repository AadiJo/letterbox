// expect: letterbox/no-node-in-renderer x10

import { readFileSync } from 'node:fs'
import { join } from 'path'
import { readFile } from 'fs/promises'
import { ipcRenderer } from 'electron'
import type { BrowserWindow } from 'electron/main'

export const load = () => readFileSync(join('a', 'b'), 'utf8') + String(readFile) + String(ipcRenderer)
export type Window = BrowserWindow

// Node's globals, bare or read off globalThis.
export const env = process.env
export const bytes = Buffer.from('mail')
export const viaGlobal = globalThis.process
export const later = () => setImmediate(() => {})
export const lazy = async () => import('node:os')
