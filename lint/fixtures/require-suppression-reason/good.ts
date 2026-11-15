// Every accepted way to give a reason. This file must stay clean.

export const nextLine = (left: number, right: string) => {
  // oxlint-disable-next-line eqeqeq -- the wire format sends this number as a string
  return left == right
}

// The wire format sends this number as a string.
// eslint-disable-next-line eqeqeq
export const reasonAbove = (left: number, right: string) => left == right

export const sameLine = (left: number, right: string) => left == right // oxlint-disable-line eqeqeq -- same reason

// The reason sits on its own line, directly above the line that has the directive.
export const sameLineReasonAbove = (left: number, right: string) => left == right // oxlint-disable-line eqeqeq

// @ts-expect-error the fixture assigns a string to a number on purpose
export const expectError: number = 'one'

// @ts-ignore: a colon before the reason is fine
export const ignore: number = 'two'

/* The reason can be a block comment. */
// @ts-expect-error
export const blockReason: number = 'three'

// One reason covers the directives stacked directly under it.
// @ts-expect-error
// oxlint-disable-next-line eqeqeq
export const stacked: boolean = (1 as number) == ('1' as string)

/* oxlint-disable eqeqeq -- a block needs its reason once, where it starts */
export const insideBlock = (left: number, right: string) => left == right
/* oxlint-enable eqeqeq */

// Prose that mentions oxlint-disable or @ts-ignore is not a directive.
export const prose = 1
