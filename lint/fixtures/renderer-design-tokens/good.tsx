// Tokens, sizes and lengths that are not type or color, and any text that is not styling, are
// all fine: a # in prose or JSON, a link to an anchor, a class written out in documentation.

const cx = (...parts: string[]) => parts.join(' ')

export const row = <p className="h-[78px] text-row font-medium text-fg">Maya</p>
export const shadow = <div className={cx('bg-sel shadow-raised ring-[1.5px] ring-line')} />
export const tinted = cx('bg-tint text-tint-fg bg-red/[0.07] border-l-2 border-line')
export const scrollbar = <div className="[scrollbar-color:var(--color-pill)_transparent]" />
export const background = <div className="bg-[length:200px_100px] bg-[url(/paper.png)]" />
export const height = <div style={{ height: 78 }} />
export const trash = { trash: '#' }
export const issue = 'Issue #123 is out'
export const ticket = '{"ticket":"#123"}'
export const link = 'https://mail.example/help#abc'
export const docs = 'Write text-[13px] nowhere: use text-row.'
export const title = <span title="Flag #1">Flag</span>
