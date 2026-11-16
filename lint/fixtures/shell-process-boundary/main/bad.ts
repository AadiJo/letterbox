// expect: letterbox/shell-process-boundary x4

import { connect } from '../preload/bridge.ts'
import { NOT_FOR_IMPORT } from '../shared/channels.ts'
export { connect as again } from '../preload/bridge.ts'

export const both = [connect, NOT_FOR_IMPORT]
export const later = () => import('../preload/bridge.ts')
