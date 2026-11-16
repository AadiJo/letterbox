// The one file that may animate an element from script.

export const shake = (element: HTMLElement) => element.animate([{ transform: 'translateX(2px)' }], 120)
