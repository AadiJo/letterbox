// What main and the preload agree on. They run in different processes and share only
// types: each side writes a channel name itself and checks it with `satisfies Channel`.

/**
 * The IPC channels between main and the preload. None carries core messages, which go
 * over the MessagePort. The first two carry the id the preload made for its document.
 *   core:connect       preload to main, once per page load: the page wants a core.
 *   core:port          main to preload: the page's end of a MessageChannelMain to that core,
 *                      for the document with that id only.
 *   attachment:save    preload to main, invoked with a blob id. Answers an AttachmentOutcome.
 *   attachment:open    the same, to open the file instead.
 *   conversation:open  main to preload, with a thread id: the person chose the notification
 *                      for that conversation, so the page should open it.
 *   url:open           preload to main, with a url the person chose to open in the browser,
 *                      such as a sender's unsubscribe page. Main opens https only.
 */
export type Channel =
  | 'core:connect'
  | 'core:port'
  | 'attachment:save'
  | 'attachment:open'
  | 'conversation:open'
  | 'url:open'
