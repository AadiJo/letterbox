// The message frame's DOM, reached only through the platform's own methods and getters.
// The frame holds the sender's markup, and markup can shadow a document's properties by name:
// `<form name="createElement">` makes `doc.createElement` that form, and an `<input
// name="setAttribute">` does the same to its form. So nothing here reads a method or a
// property off the frame's objects: each call goes through the prototype that defines it,
// with the frame's object as `this`. Body.tsx and images.ts use it.

/** The getter `name` defines on `prototype`, as a function of the object to read. */
function getter<Value>(prototype: object, name: string): (target: object) => Value {
  const get = Object.getOwnPropertyDescriptor(prototype, name)?.get
  if (!get) throw new Error(`no getter ${name}`)
  return (target) => get.call(target)
}

const rootOf = getter<HTMLElement | null>(Document.prototype, 'documentElement')
const bodyOf = getter<HTMLElement | null>(Document.prototype, 'body')
const localName = getter<string>(Element.prototype, 'localName')
const textOf = getter<string | null>(Node.prototype, 'textContent')
const parentOf = getter<Node | null>(Node.prototype, 'parentNode')
const previousOf = getter<Node | null>(Node.prototype, 'previousSibling')
const valueOf = getter<string | null>(Node.prototype, 'nodeValue')
const styleOf = getter<CSSStyleDeclaration>(HTMLElement.prototype, 'style')
const scrollHeight = getter<number>(Element.prototype, 'scrollHeight')
const clientHeight = getter<number>(Element.prototype, 'clientHeight')
const offsetHeight = getter<number>(HTMLElement.prototype, 'offsetHeight')
/** `createElement` with one signature, so `call` takes any tag name. */
const createElement: (this: Document, name: string) => Element = Document.prototype.createElement

export const frameDom = {
  root: rootOf,
  body: bodyOf,
  localName,
  text: textOf,
  /** Every element under `doc` that `selector` matches. */
  all: (doc: Document, selector: string): Element[] => [...Document.prototype.querySelectorAll.call(doc, selector)],
  create: (doc: Document, name: string) => createElement.call(doc, name),
  get: (element: Element, name: string): string | null => Element.prototype.getAttribute.call(element, name),
  set: (element: Element, name: string, value: string) => Element.prototype.setAttribute.call(element, name, value),
  unset: (element: Element, name: string) => Element.prototype.removeAttribute.call(element, name),
  replace: (element: Element, by: Node) => Element.prototype.replaceWith.call(element, by),
  /** Sets a custom property on the frame's root element. */
  setProperty: (doc: Document, name: string, value: string) => {
    const root = rootOf(doc)
    if (root) CSSStyleDeclaration.prototype.setProperty.call(styleOf(root), name, value)
  },
  /**
   * How tall the frame must be to show its whole document: the root's own height, which takes in
   * margins the sender's CSS gives the body, or the scrolled height when content overflows the
   * frame as it is. The root's scrolled height alone is never less than the frame, so it could
   * not shrink, as when a quote folds.
   */
  height: (doc: Document) => {
    const root = rootOf(doc)
    if (!root) return 0
    const scrolled = scrollHeight(root)
    return scrolled > clientHeight(root) ? scrolled : offsetHeight(root)
  },
  /**
   * Takes out everything before the comment `marker` in reading order, up to the body, so the
   * frame shows only what follows it: the quoted history, in the same wrappers and styles.
   * The sender's `<style>` elements stay. Does nothing when the marker is not there.
   */
  keepFrom: (doc: Document, marker: string) => {
    const body = bodyOf(doc)
    if (!body) return
    const walker = Document.prototype.createTreeWalker.call(doc, body, NodeFilter.SHOW_COMMENT)
    let found: Node | null = null
    for (let node = walker.nextNode(); node && !found; node = walker.nextNode()) {
      if (valueOf(node) === marker) found = node
    }
    for (let node = found; node && node !== body; node = parentOf(node)) {
      const parent = parentOf(node)
      for (let before = previousOf(node); before;) {
        const next = previousOf(before)
        const kept = before.nodeType === Node.ELEMENT_NODE && localName(before) === 'style'
        if (!kept && parent) Node.prototype.removeChild.call(parent, before)
        before = next
      }
    }
  },
}
