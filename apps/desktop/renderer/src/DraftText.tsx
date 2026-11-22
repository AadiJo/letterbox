// The draft's text: a plain textarea, so what the user types, pastes or enters through an IME
// is exactly what is kept and sent, and the browser's own undo and focus work. It reads like the
// body it answers, 16/26 type no wider than 62ch, on the body's left edge (the dock lines them
// up). It grows with its text from 120 px. The dock scrolls it past 40% of the reader, and the
// compose page scrolls with it.

import type { DraftKey } from './drafts.ts'
import { edit } from './drafts.ts'

type Props = {
  id: DraftKey
  text: string
  readOnly: boolean
  placeholder: string
  /** The dock's inset field, or the compose page, where it sits 18 px under the subject. */
  look?: 'dock' | 'page'
}

const LOOKS = {
  dock: 'max-w-[calc(62ch+32px)] px-4 py-3 wide:max-w-[calc(62ch+48px)] wide:px-6',
  page: 'mt-[18px] max-w-[62ch]',
} as const

export function DraftText({ id, text, readOnly, placeholder, look = 'dock' }: Props) {
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
      className={`block min-h-[120px] w-full resize-none bg-transparent text-body text-prose caret-blue outline-none [field-sizing:content] placeholder:text-faint ${LOOKS[look]}`}
    />
  )
}
