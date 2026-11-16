// expect: letterbox/renderer-design-tokens x15

export const hex = <p className="bg-[#1b1b1e]">Reader</p>
export const rgb = 'hover:[color:rgb(255_255_255/60%)]'
export const fill = `bg-[var(--x)] text-fg`
export const size = <p className="text-[13px] text-fg">Row</p>
export const length = 'text-[length:19px]'
export const leading = 'text-row leading-[1.4]'
export const shadow = 'shadow-[0_1px_2px_black]'
export const ring = 'ring-[red]'
export const scale = <p className="text-sm text-muted">Meta</p>
export const palette = 'bg-white text-red-500'
export const property = '[font-size:19px]'
export const inlineSize = <p style={{ fontSize: 19 }}>Big</p>
export const inlineColor = <p style={{ color: 'red', boxShadow: '0 1px 2px black' }}>Loud</p>
export const css = '<style>p{color:#333}</style>'
