// Where a float that opens from a control may go: inside the part of the reader the person sees.

/** The box of the nearest element around `element` that scrolls: the reader's visible part. */
export function visibleBounds(element: Element) {
  for (let at = element.parentElement; at; at = at.parentElement) {
    if (/auto|scroll/.test(getComputedStyle(at).overflowY)) return at.getBoundingClientRect()
  }
  return document.documentElement.getBoundingClientRect()
}
