// expect: letterbox/shell-process-boundary x2

import { port } from '../main/window.ts'
import type { Channel } from '../main/window.ts'

export const name: Channel | string = port
