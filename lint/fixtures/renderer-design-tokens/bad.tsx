// expect: letterbox/renderer-design-tokens x6

export const hex = <p className="bg-[#1b1b1e]">Reader</p>
export const rgb = <p style={{ color: 'rgb(255 255 255 / 60%)' }}>Muted</p>
export const hsl = (hue: number) => `hsl(${hue} 70% 60%)`
export const size = <p className="text-[13px] text-fg">Row</p>
export const leading = 'text-row leading-[1.4]'
export const scale = <p className="text-sm text-muted">Meta</p>
