// expect: letterbox/no-cross-package-relative-import x1

// The package root is the nearest folder with a package.json, however deep the file sits.
import { thing } from '../../../beta/src/thing.ts'

export const deep = thing
