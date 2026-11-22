// The conversation the person last chose from a notification (the desktop shell's), for App
// to open. The page listens once, as this module loads and before React renders, so it is
// the bridge's first listener: the preload hands it an id that came before the page loaded,
// as when a notification opens a new window. A plain browser tab has no shell, and nothing
// ever comes.

import type { ThreadId } from '@letterbox/protocol'
import { useSyncExternalStore } from 'react'

/** A new object for each choice, so choosing the same conversation again counts again. */
export type Chosen = { id: ThreadId }

let chosen: Chosen | null = null
const watchers = new Set<() => void>()

window.letterbox?.onOpenConversation((id) => {
  chosen = { id }
  for (const watcher of watchers) watcher()
})

const subscribe = (onChange: () => void) => {
  watchers.add(onChange)
  return () => void watchers.delete(onChange)
}

/** The latest choice, or null before any. */
export function useChosen() {
  return useSyncExternalStore(subscribe, () => chosen)
}
