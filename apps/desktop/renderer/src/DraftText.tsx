// The reply's text: a plain textarea, so what the user types, pastes or enters through an IME
// is exactly what is kept and sent, and the browser's own undo and focus work. It reads like the
// body it answers, 16/26 type no wider than 62ch, on the body's left edge (the dock lines them
// up). It grows with its text from 120 px, and the dock scrolls it past 40% of the reader.

import type { ThreadId } from '@letterbox/protocol'
import { edit } from './drafts.ts'

type Props = { id: ThreadId; text: string; readOnly: boolean; placeholder: string }

export function DraftText({ id, text, readOnly, placeholder }: Props) {
  return (
    <textarea
      aria-label="Message"
      data-field="draft"
      value={text}
      readOnly={readOnly}
      placeholder={placeholder}
      onChange={(event) => {
        const next = event.target.value
        edit(id, (current) => ({ ...current, text: next }))
      }}
      className="block min-h-[120px] w-full max-w-[calc(62ch+32px)] resize-none bg-transparent px-4 py-3 text-body text-prose caret-blue outline-none [field-sizing:content] placeholder:text-faint wide:max-w-[calc(62ch+48px)] wide:px-6"
    />
  )
}
