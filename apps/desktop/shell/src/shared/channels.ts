// What main and the preload agree on. They run in different processes and share only
// types: each side writes a channel name itself and checks it with `satisfies Channel`.

/**
 * The IPC channels between main and the preload. Neither carries core messages, which go
 * over the MessagePort.
 *   core:connect  preload to main, once per page load: the page wants a core.
 *   core:port     main to preload: the page's end of a MessageChannelMain to that core.
 */
export type Channel = 'core:connect' | 'core:port'
