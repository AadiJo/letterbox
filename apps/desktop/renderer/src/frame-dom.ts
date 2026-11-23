// The message frame's DOM, reached only through the platform's own methods and getters.
// The frame holds the sender's markup, and markup can shadow a document's properties by name:
// `<form name="createElement">` makes `doc.createElement` that form, and an `<input
// name="setAttribute">` does the same to its form. So nothing here reads a method or a
// property off the frame's objects: each call goes through the prototype that defines it,
// with the frame's object as `this`. Body.tsx, images.ts and colors.ts use it.

/** The getter `name` defines on `prototype`, as a function of the object to read. */
function getter<Value>(prototype: object, name: string): (target: object) => Value {
  const get = Object.getOwnPropertyDescriptor(prototype, name)?.get
  if (!get) throw new Error(`no getter ${name}`)
  return (target) => get.call(target)
}

const rootOf = getter<HTMLElement | null>(Document.prototype, 'documentElement')
const bodyOf = getter<HTMLElement | null>(Document.prototype, 'body')
const headOf = getter<HTMLHeadElement | null>(Document.prototype, 'head')
const defaultViewOf = getter<Window | null>(Document.prototype, 'defaultView')
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

/** The comment `marker` in the body's tree, or null. A TreeWalker does not go into a `<template>`'s content. */
function markerIn(doc: Document, marker: string): Node | null {
  const body = bodyOf(doc)
  if (!body) return null
  const walker = Document.prototype.createTreeWalker.call(doc, body, NodeFilter.SHOW_COMMENT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (valueOf(node) === marker) return node
  }
  return null
}

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
  /** Sets a property on the frame's root element's own style, `important` when asked. */
  setProperty: (doc: Document, name: string, value: string, priority: '' | 'important' = '') => {
    const root = rootOf(doc)
    if (root) CSSStyleDeclaration.prototype.setProperty.call(styleOf(root), name, value, priority)
  },
  /** True while `doc` is a frame's current document: one its frame dropped has no window. */
  current: (doc: Document) => defaultViewOf(doc) !== null,
  /** Takes a custom property off the frame's root element. */
  removeProperty: (doc: Document, name: string) => {
    const root = rootOf(doc)
    if (root) CSSStyleDeclaration.prototype.removeProperty.call(styleOf(root), name)
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
  /** True when the comment `marker` is in the body's tree. One in a `<template>`'s content is not. */
  hasMarker: (doc: Document, marker: string) => markerIn(doc, marker) !== null,
  /**
   * Takes out everything before the comment `marker` in reading order, up to the body, so the
   * frame shows only what follows it: the quoted history, in the same wrappers and styles. Every
   * `<style>` in what goes is moved into the head first, so the sender's styles all still apply.
   * A selector that counts on the siblings taken out, such as `p + div`, may then match less.
   * Does nothing when the marker is not in the body's tree.
   */
  keepFrom: (doc: Document, marker: string) => {
    const body = bodyOf(doc)
    const head = headOf(doc)
    // What goes, each with the parent it goes from: every node before the marker, level by level up to the body.
    const gone: { parent: Node; node: Node }[] = []
    for (let node = markerIn(doc, marker); node && node !== body; node = parentOf(node)) {
      const parent = parentOf(node)
      if (!parent) break
      for (let before = previousOf(node); before; before = previousOf(before)) gone.push({ parent, node: before })
    }
    // Their stylesheets move first, kept in document order, so rules of the same weight still
    // apply in the order the sender wrote them. The walk above went backward, so it sorts them.
    const styles = gone.flatMap(({ node }) =>
      node.nodeType !== Node.ELEMENT_NODE
        ? []
        : localName(node) === 'style'
          ? [node]
          : [...Element.prototype.querySelectorAll.call(node, 'style')],
    )
    styles.sort((a, b) =>
      Node.prototype.compareDocumentPosition.call(a, b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
    )
    if (head) for (const style of styles) Node.prototype.appendChild.call(head, style)
    for (const { parent, node } of gone) if (parentOf(node) === parent) Node.prototype.removeChild.call(parent, node)
  },
}
