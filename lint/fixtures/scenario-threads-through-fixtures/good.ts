const core = {
  subscribe: (query: object) => query,
  query: (query: object) => query,
  sendRaw: (value: object) => value,
}

export const list = core.subscribe({ view: 'threads', filter: {}, offset: 0, limit: 50 })
export const accounts = core.query({ view: 'accounts' })
// Malformed input on purpose is not a conversation the scenario reads.
export const raw = core.sendRaw({ kind: 'subscribe', sub: 'sub_x', query: { view: 'thread' } })
