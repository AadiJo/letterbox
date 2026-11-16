// The shell talks to Electron and Node, and shares only the bridge's type with the page.
// This file must stay clean.

import { join } from 'node:path'
import type { ShellBridge } from '@letterbox/client/message-port'

export const preload = (folder: string) => join(folder, 'preload.cjs')
export const bridge = (connect: () => void): ShellBridge => ({ platform: 'linux', connect })
// A name that only starts like react is someone else's package.
export const later = () => import('react-native-like-but-not')
