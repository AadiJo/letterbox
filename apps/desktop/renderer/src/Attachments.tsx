// The files a message carries, under its body: a chip each with the file's type, name and size.
// Inline images belong to the body, so only attachments proper show here.

import type { Attachment } from '@letterbox/protocol'
import { FILE_HUE, tint } from './hue.ts'

const KB = 1024

/** "212 KB" or "1.4 MB". */
const sizeOf = (bytes: number) =>
  bytes < KB * KB ? `${Math.max(1, Math.round(bytes / KB))} KB` : `${(bytes / KB / KB).toFixed(1)} MB`

/** The type a file's name ends in, such as PDF, or FILE when it has none. */
const typeOf = (name: string) => (/\.([a-z0-9]{1,4})$/i.exec(name)?.[1] ?? 'file').toUpperCase()

export function Attachments({ attachments }: { attachments: readonly Attachment[] }) {
  const files = attachments.filter((attachment) => !attachment.inline)
  if (files.length === 0) return null
  return (
    <ul className="mt-[18px] flex flex-wrap gap-2">
      {files.map((file) => (
        <li
          key={file.blobId}
          data-field="attachment"
          className="inline-flex h-10 max-w-full items-center gap-2.5 rounded-[9px] pr-3.5 pl-2.5 text-addr text-fg2 inset-ring inset-ring-hover"
        >
          <span
            style={tint(FILE_HUE)}
            className="flex-none rounded-[5px] bg-tint px-[5px] py-[3px] text-tiny font-bold tracking-[0.04em] text-tint-fg"
          >
            {typeOf(file.name)}
          </span>
          <span className="min-w-0 truncate">{file.name}</span>
          <span className="flex-none text-muted tabular-nums">{sizeOf(file.size)}</span>
        </li>
      ))}
    </ul>
  )
}
