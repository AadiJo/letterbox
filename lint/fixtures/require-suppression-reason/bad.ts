// expect: letterbox/require-suppression-reason x10

export const nextLine = (left: number, right: string) => {
  // oxlint-disable-next-line eqeqeq
  return left == right
}

// eslint-disable-next-line eqeqeq
export const eslintSpelling = (left: number, right: string) => left == right

export const sameLine = (left: number, right: string) => left == right // oxlint-disable-line eqeqeq

export const blanketLine = (left: number, right: string) => left == right // oxlint-disable-line

// @ts-expect-error
export const expectError: number = 'one'

// @ts-ignore
export const ignore: number = 'two'

/* @ts-expect-error */
export const blockSpelling: number = 'three'

export const trailing = 1 // A comment that shares its line with code is not a reason.
// oxlint-disable-next-line eqeqeq
export const afterTrailing = (left: number, right: string) => left == right

//
// oxlint-disable-next-line eqeqeq
export const afterEmpty = (left: number, right: string) => left == right

// A reason must sit directly above. The blank line under this comment breaks the link.

// oxlint-disable-next-line eqeqeq
export const reasonTooFar = (left: number, right: string) => left == right
