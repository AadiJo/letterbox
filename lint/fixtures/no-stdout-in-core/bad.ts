// expect: letterbox/no-stdout-in-core x9

export const print = (problem: string) => console.log(problem)
export const complain = (problem: string) => console.error(problem)
export const write = (line: string) => process.stdout.write(`${line}\n`)
export const writeError = (line: string) => process.stderr.write(`${line}\n`)

// Reaching them through globalThis, or handing them out without a call, changes nothing.
export const viaGlobal = (value: unknown) => globalThis.console.debug(value)
export const writeViaGlobal = (line: string) => globalThis.process.stdout.write(line)
export const log = console.log
export const { info } = console
export const stream = process.stdout
