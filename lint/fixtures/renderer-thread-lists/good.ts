// One conversation's detail is fine. Lists go through threads.ts.

declare const useView: (query: object) => unknown

export const open = () => useView({ view: 'thread', threadId: 'thread-1' })
