// expect: letterbox/scenario-threads-through-fixtures x3
const core = { subscribe: (query: object) => query, query: (query: object) => query }
const threadId = 'thread_1'

export const watched = core.subscribe({ view: 'thread', threadId })
export const read = core.query({ view: 'thread', threadId })
export const quoted = core.query({ threadId, view: 'thread' })
