// expect: letterbox/no-cross-package-relative-import x7

import type { Thing } from '../../beta/src/thing.ts'
import { thing } from '../../beta/src/thing.ts'
import { missing } from '../../../not-a-package.ts'

export { thing as reexported } from '../../beta/src/thing.ts'
export * from '../../beta/src/thing.ts'
export type Lazy = import('../../beta/src/thing.ts').Thing
export const load = () => import('../../beta/src/thing.ts')
export const use = (value: Thing) => [thing, value, missing]
