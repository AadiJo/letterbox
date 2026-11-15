// expect: letterbox/no-provider-names x18

// Identifiers. A provider name counts as a whole word of the name, in any casing.
export const gmailLabels = ['a']
export const isOutlook = false
export const IMAP_PORT = 993
export const imapMailbox = 'INBOX'
export const IMAPClient = { exchangeServer: 'mail.example.org' }
export type JmapSession = { fromICloud: boolean }
export const CATEGORY_PROMOTIONS = 'promotions'

// One occurrence is one error, even where the syntax tree holds the name twice.
export const shorthand = { gmailLabels }

// String literals, as values and as types.
export const host = 'imap.fastmail.com'
export const signIn = 'https://accounts.google.com/o/oauth2/v2/auth'
export const header = 'X-GM-LABELS'
export const isBridge = (server: string) => server.endsWith('.protonmail.ch')
export type Kind = 'yahoo' | 'other'
export const isCategory = (label: string) => label.toLowerCase().startsWith('category_')

// Template literals.
export const graph = (path: string) => `https://graph.microsoft.com/${path}`
export const greeting = (name: string) => `${name} uses Proton Mail`
