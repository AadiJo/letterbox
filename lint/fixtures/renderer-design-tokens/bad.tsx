// expect: letterbox/renderer-design-tokens x22

const cx = (...parts: string[]) => parts.join(' ')
export const element = document.createElement('p')

export const hex = <p className="bg-[#1b1b1e]">Reader</p>
export const fnColor = <p className="hover:[color:rgb(255_255_255/60%)]">Muted</p>
export const size = <p className="text-[13px] text-fg">Row</p>
export const length = cx('text-[length:19px]')
export const leading = cx('text-row leading-[1.4]')
export const shadow = cx('shadow-[0_1px_2px_black]')
export const ring = cx('ring-[red]')
export const scale = <p className="text-sm text-muted">Meta</p>
export const white = <p className="bg-white">Paper</p>
export const side = <p className="border-l-red-500">Side</p>
export const property = <p className="[border-top-color:red]">Top</p>
export const fontSize = <p className="[font-size:19px]">Big</p>
export const icon = { className: 'text-red-500' }
export const inlineSize = <p style={{ fontSize: 19 }}>Big</p>
export const inlineColor = <p style={{ color: 'red', boxShadow: '0 1px 2px black' }}>Loud</p>
export const inlineTop = <p style={{ borderTopColor: 'red' }}>Top</p>
export const css = '<style>p{color:#333}</style>'
element.style.borderTopColor = 'red'
// A class list kept in a constant is read where a className or cx() uses it.
const CLASS = 'text-[15px] text-fg'
const OTHER = `bg-[#fff]`
export const constant = <p className={CLASS}>Fifteen</p>
export const joined = cx(OTHER)
export const gradient = <div style={{ backgroundImage: 'linear-gradient(red, blue)' }} />
