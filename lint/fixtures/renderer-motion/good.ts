// Reading animations, and a function of our own named animate, are fine.

export const running = (element: HTMLElement) => element.getAnimations().length
export const animate = (value: number) => value * 2
export const doubled = animate(2)
