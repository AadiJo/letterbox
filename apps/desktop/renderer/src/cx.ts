// Joins class names, leaving out the ones a condition turned off. lint/rules/renderer-design-tokens.ts
// reads every string passed here, as it reads a className attribute, and any `const` string in
// the same file that either one names.

export const cx = (...parts: readonly (string | false | null | undefined)[]) =>
  parts.filter((part) => typeof part === 'string' && part !== '').join(' ')
