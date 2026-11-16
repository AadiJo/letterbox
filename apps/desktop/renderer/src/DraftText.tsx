// The reply's text, written in paragraphs that look like the received body: 16/26 type,
// 62ch lines, 16 px between paragraphs. A textarea can only show a paragraph break as a blank
// line, so this is an editable block of <p>s. The draft stays plain text (drafts.ts): Enter
// starts a paragraph, which is a blank line in the text, and Shift+Enter breaks a line.
// Paste and drop bring plain text only, and no formatting shortcut applies.

import type { ThreadId } from '@letterbox/protocol'
import { type ClipboardEvent, type KeyboardEvent, useState } from 'react'
import { edit } from './drafts.ts'

const escape = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

/** The editor's markup for `text`: a <p> per paragraph, a <br> per line break, and an empty paragraph to type in. */
const htmlOf = (text: string) =>
  text
    .split('\n\n')
    .map((paragraph) => `<p>${escape(paragraph).replaceAll('\n', '<br>') || '<br>'}</p>`)
    .join('')

/** A block's text: its text, a line break per <br>, less the <br> a browser leaves to hold an empty or ended line. */
function blockText(block: Node) {
  const walk = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? ''
    if (node.nodeName === 'BR') return '\n'
    return [...node.childNodes].map(walk).join('')
  }
  return walk(block).replace(/\n$/, '')
}

/** The plain text the editor holds: its paragraphs, a blank line between each two. */
function textOf(root: HTMLElement) {
  const paragraphs: string[] = []
  let loose: Node[] = []
  const flush = () => {
    if (loose.length > 0) paragraphs.push(loose.map(blockText).join(''))
    loose = []
  }
  for (const node of root.childNodes) {
    if (node.nodeName === 'P' || node.nodeName === 'DIV') {
      flush()
      paragraphs.push(blockText(node))
    } else loose.push(node)
  }
  flush()
  return paragraphs.join('\n\n')
}

/**
 * Puts text typed straight into the editor, as after deleting everything, into a paragraph of
 * its own, so every line of the draft is styled as a paragraph. The caret stays where it was.
 */
function wrapLoose(root: HTMLElement) {
  const loose = [...root.childNodes].filter((node) => node.nodeName !== 'P' && node.nodeName !== 'DIV')
  const [first] = loose
  if (!first) return
  const selection = window.getSelection()
  const caret = selection && { node: selection.anchorNode, offset: selection.anchorOffset }
  const paragraph = document.createElement('p')
  first.before(paragraph)
  paragraph.append(...loose)
  if (caret?.node && paragraph.contains(caret.node)) selection?.collapse(caret.node, caret.offset)
}

/** Inserts plain text where the caret is, as the editor's own paragraphs and line breaks. */
function insertPlain(text: string) {
  text
    .replaceAll('\r\n', '\n')
    .split(/\n{2,}/)
    .forEach((paragraph, index) => {
      if (index > 0) document.execCommand('insertParagraph')
      paragraph.split('\n').forEach((line, at) => {
        if (at > 0) document.execCommand('insertLineBreak')
        if (line !== '') document.execCommand('insertText', false, line)
      })
    })
}

/** Bold, italic and underline would show in the editor, and never be sent. */
const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
  if ((event.metaKey || event.ctrlKey) && ['b', 'i', 'u'].includes(event.key.toLowerCase())) event.preventDefault()
}

const onPaste = (event: ClipboardEvent<HTMLElement>) => {
  event.preventDefault()
  insertPlain(event.clipboardData.getData('text/plain'))
}

type Props = { id: ThreadId; text: string; readOnly: boolean; placeholder: string }

export function DraftText({ id, text, readOnly, placeholder }: Props) {
  // What the editor's markup was made from. When the draft's text changes from outside, as
  // when Undo puts a reply back, the editor is made again from the new text. While the user
  // types, the two stay equal, and the browser's own editing is left alone.
  const [made, setMade] = useState({ serial: 0, text, html: htmlOf(text) })
  if (text !== made.text) setMade({ serial: made.serial + 1, text, html: htmlOf(text) })

  return (
    <div className="relative">
      <div
        key={made.serial}
        role="textbox"
        aria-multiline
        aria-label="Message"
        aria-readonly={readOnly}
        data-field="draft"
        contentEditable={!readOnly}
        suppressContentEditableWarning
        spellCheck
        // The markup is escaped text, made once per `made` (see above), so React never rewrites what the user types.
        dangerouslySetInnerHTML={{ __html: made.html }}
        onFocus={() => document.execCommand('defaultParagraphSeparator', false, 'p')}
        onInput={(event) => {
          wrapLoose(event.currentTarget)
          const next = textOf(event.currentTarget)
          setMade({ ...made, text: next })
          edit(id, (current) => ({ ...current, text: next }))
        }}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onDrop={(event) => event.preventDefault()}
        className="min-h-[120px] px-4 pt-3 pb-3 text-body break-words whitespace-pre-wrap text-prose caret-blue outline-none wide:px-6 [&>p]:mb-4 [&>p]:max-w-[62ch] [&>p:last-child]:mb-0"
      />
      {text === '' && (
        <p aria-hidden className="pointer-events-none absolute top-3 left-4 text-body text-faint wide:left-6">
          {placeholder}
        </p>
      )}
    </div>
  )
}
