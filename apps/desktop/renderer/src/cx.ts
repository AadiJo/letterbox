// Joins class names, leaving out the ones a condition turned off. A class list kept in a
// constant goes through here, so lint/rules/renderer-design-tokens.ts reads it as it reads a
// className attribute.

export const cx = (...parts: readonly (string | false | null | undefined)[]) =>
  parts.filter((part) => typeof part === 'string' && part !== '').join(' ')
