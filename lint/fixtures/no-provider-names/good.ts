// Provider-neutral code. This file must stay clean.

// Comments may name a provider: Gmail, Outlook, IMAP, X-GM-LABELS, CATEGORY_SOCIAL.

/** Gmail calls these labels and IMAP calls them folders. The core calls both mailboxes. */
export type Capabilities = { multipleMailboxes: boolean }

// The list matches whole words only. These names only contain a listed word.
export const minimap = 1
export const exchanged = true
export const protons = 2
export const GOOGLED = 3

export const categoryName = 'category'
export const note = 'Outlooks differ, and nobody googled it.'
export const count = (found: number) => `${found} protons`
export const providerLabel = 'Example Mail'
