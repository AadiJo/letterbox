// Main's entry. It turns on Node's compile cache first, so the rest of main (app.ts, a
// separate chunk) is compiled from cache from the second start on.

import { enableCompileCache } from 'node:module'

enableCompileCache()
void import('./app.ts')
