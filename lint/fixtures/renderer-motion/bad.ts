// expect: letterbox/renderer-motion x2

export const spin = (element: HTMLElement) =>
  element.animate([{ transform: 'rotate(360deg)' }], { duration: 800, iterations: Infinity })
export const pulse = (element: HTMLElement) => element['animate']([{ opacity: 0.5 }], 1000)
