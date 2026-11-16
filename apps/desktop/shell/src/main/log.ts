// Main's log: one `[shell] ...` line per event, to stdout and to main.log in the user data
// folder, where a check, or a person helping with a bug, can read it from the first line on.

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

let file: string | undefined

/** Appends every later line to `path` as well. */
export function logTo(path: string) {
  mkdirSync(dirname(path), { recursive: true })
  file = path
}

export function log(line: string) {
  const text = `[shell] ${line}`
  console.log(text)
  if (file !== undefined) appendFileSync(file, `${text}\n`)
}
