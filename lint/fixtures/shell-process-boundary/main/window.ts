// Main's side. A file in the same folder may import it. This file must stay clean.

import { type Channel } from '../shared/channels.ts'

export const port = 'core:port' satisfies Channel
