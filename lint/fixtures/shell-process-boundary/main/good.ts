// Main imports its own folder, takes types from shared, and names the preload's file by path only.
// This file must stay clean.

import { join } from 'node:path'
import type { Channel } from '../shared/channels.ts'
import { port } from './window.ts'

export const preload = (folder: string) => join(folder, 'preload.cjs')
export const channel: Channel = port
export type Port = import('../shared/channels.ts').Channel
