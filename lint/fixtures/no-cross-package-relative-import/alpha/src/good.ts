// Imports that stay inside the package, and imports by package name.
// This file must stay clean.

import { join } from 'node:path'
import type { Thing } from '@fixture/beta/thing'
import { base } from './base.ts'
import { inner } from './nested/inner.ts'

export { base } from './base.ts'
export const describe = (value: Thing) => join(base, inner, value.name)
export const load = () => import('./nested/inner.ts')
