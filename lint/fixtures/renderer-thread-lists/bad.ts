// expect: letterbox/renderer-thread-lists x2

declare const useView: (query: object) => unknown

export const everything = () => useView({ view: 'threads', filter: {}, offset: 0, limit: 5000 })
export const quoted = { view: 'threads' }
