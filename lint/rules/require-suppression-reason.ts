// Every suppression must say why it is there.
//
// A reason is one of:
//   `-- reason` at the end of an oxlint-disable or eslint-disable directive
//   text after @ts-expect-error, @ts-ignore or @ts-nocheck
//   a comment on its own line directly above. Directives stacked in between are skipped,
//   so one reason can cover a stack of them.

import { defineRule, type Comment } from '@oxlint/plugins'

const MESSAGE =
  'Say why this suppression is needed. End an oxlint-disable or eslint-disable directive with `-- reason`, ' +
  'write the reason after a @ts- directive, or put a comment on its own line directly above. ' +
  'A suppression with no reason will be read as a mistake.'

/** Matches a TypeScript directive comment and captures whatever follows the directive. */
const TS_DIRECTIVE = /^[\s*]*@ts-(?:expect-error|ignore|nocheck)(?![\w-])(.*)$/s

/** True when the string has at least one letter or digit, so "", "--" and ":" are not reasons. */
const hasText = (text: string) => /[\p{L}\p{N}]/u.test(text)

export default defineRule({
  meta: {
    type: 'problem',
    docs: { description: 'Require a reason on every lint and type-check suppression.' },
  },
  create(context) {
    const { sourceCode } = context

    /** True when nothing but whitespace shares the comment's first and last line. */
    const standsAlone = ({ loc }: Comment) => {
      const before = sourceCode.lines[loc.start.line - 1]?.slice(0, loc.start.column) ?? ''
      const after = sourceCode.lines[loc.end.line - 1]?.slice(loc.end.column) ?? ''
      return before.trim() === '' && after.trim() === ''
    }

    return {
      Program() {
        const comments = sourceCode.getAllComments()
        // Both kinds of directive in one shape. `oxlint-enable` suppresses nothing, so it needs no reason.
        const directives = [
          ...sourceCode.getDisableDirectives().directives.map(({ type, node, justification }) => ({
            comment: node,
            reason: justification,
            suppresses: type !== 'enable',
          })),
          ...comments.flatMap((comment) => {
            const [, reason] = TS_DIRECTIVE.exec(comment.value) ?? []
            return reason === undefined ? [] : [{ comment, reason, suppresses: true }]
          }),
        ]
        const directiveStarts = new Set(directives.map(({ comment }) => comment.start))
        const aloneByLastLine = new Map(comments.filter(standsAlone).map((comment) => [comment.loc.end.line, comment]))

        /** Looks for a prose comment directly above, walking up past any stacked directives. */
        const explainedAbove = (directive: Comment) => {
          let above = aloneByLastLine.get(directive.loc.start.line - 1)
          while (above && directiveStarts.has(above.start)) above = aloneByLastLine.get(above.loc.start.line - 1)
          return above !== undefined && hasText(above.value)
        }

        for (const { comment, reason, suppresses } of directives) {
          if (!suppresses || hasText(reason) || explainedAbove(comment)) continue
          // Report a zero-width range at the start of the directive's line. A report on the
          // comment itself lies inside the range that a blanket `oxlint-disable` or
          // `oxlint-disable-line` silences, so the directive would hide its own error.
          const start = { line: comment.loc.start.line, column: 0 }
          context.report({ loc: { start, end: start }, message: MESSAGE })
        }
      },
    }
  },
})
