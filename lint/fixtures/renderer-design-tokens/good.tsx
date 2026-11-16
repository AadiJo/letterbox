// Tokens, sizes that are not type, a ring's width, plain text with a # in it, and a link to an
// anchor are all fine.

export const row = <p className="h-[78px] text-row font-medium text-fg">Maya</p>
export const shadow = <div className="bg-sel shadow-raised ring-[1.5px] ring-line" />
export const tinted = 'bg-tint text-tint-fg bg-red/[0.07]'
export const height = <div style={{ height: 78 }} />
export const trash = { trash: '#' }
export const issue = 'Issue #123 is out'
export const link = 'https://mail.example/help#abc'
export const title = <span title="Flag #1">Flag</span>
