// The one origin the renderer loads from: Vite serves the renderer, `/core` is a WebSocket
// to a core-sim of its own, and `/dev/deliver` adds new mail at the sim provider.
//
// Each WebSocket gets a fresh core over the shared dev store. The store allows one core at a
// time, so a new tab, or a reload, stops the core of the tab before it. In the desktop loop
// the shell's main process owns the core, so `/core` is off and a stray tab cannot start one.

import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { createServer as createViteServer } from 'vite'
import { type WebSocket, WebSocketServer } from 'ws'
import { type CoreProcess, type Paths, startCore } from './core.ts'
import { listen } from './port.ts'

/** The sim the page shows. */
export type Sim = {
  /** The seed's fixed time: core-sim's --now, and the time the renderer measures ages from. */
  now: string
  /** Adds `count` new automated messages at the sim provider. */
  deliver(count: number): void
}

/**
 * With `relay: true`, as in `pnpm dev`, each tab's core is a core-sim behind `/core`. With
 * `relay: false`, as in `pnpm dev:desktop`, the shell starts the core, and a real core has no
 * sim: it runs on the clock and nothing can deliver to it.
 */
export type ServerOptions = {
  paths: Paths
  /** The port to try first. The next free one is used if it is taken. 0 lets the system pick. */
  port: number
  /**
   * core-sim flags for the next tab's core, read as each one starts. A UI check that runs the
   * parts in its own process uses it, as ui/reply.ts holds a send's undo window with `--hold-waits`.
   */
  coreFlags?: () => readonly string[]
} & ({ relay: true; sim: Sim } | { relay: false; sim: Sim | undefined })

export type DevServer = {
  /** The page, for example http://127.0.0.1:24349/. */
  url: string
  /** Stops the tab's core, then the server. */
  close(): Promise<void>
}

/** The most messages one `/dev/deliver` call adds. */
const MAX_DELIVER = 500

/** The WebSocket close code a tab gets when a newer tab takes the core. */
const REPLACED = 4000

/** Relays each `/core` WebSocket to its own core, one at a time. */
function coreRelay(paths: Paths, now: string, flags: () => readonly string[]) {
  let current: { socket: WebSocket; core: Promise<CoreProcess> } | undefined

  /** Takes over the store for `socket`: stops the previous tab's core, then starts this one's. */
  const connect = (socket: WebSocket) => {
    const previous = current
    // Messages that arrive before the core starts are passed on once it has, in order.
    const early: string[] = []
    let started: CoreProcess | undefined
    socket.on('message', (data) => (started ? started.send(String(data)) : early.push(String(data))))
    const core = (async () => {
      if (previous) {
        previous.socket.close(REPLACED, 'another tab opened the core')
        await (await previous.core).stop()
      }
      const next = startCore(paths, now, flags())
      next.onLine((line) => socket.send(line))
      void next.exited.then(() => socket.close(1011, 'the core exited'))
      for (const line of early.splice(0)) next.send(line)
      started = next
      return next
    })()
    socket.on('close', () => void core.then((stopping) => stopping.stop()))
    current = { socket, core }
  }

  return {
    connect,
    /** Stops the current tab's core. */
    close: async () => {
      current?.socket.close(1001, 'the dev host is stopping')
      await (await current?.core)?.stop()
    },
  }
}

/** Reads a small JSON body. */
const readJson = (request: IncomingMessage) =>
  new Promise<unknown>((resolve, reject) => {
    let body = ''
    request.on('data', (chunk: Buffer) => void (body += chunk.toString()))
    request.on('end', () => {
      try {
        resolve(JSON.parse(body))
      } catch (error) {
        reject(error)
      }
    })
  })

/** `POST /dev/deliver` with `{ "count": n }`. Answers 204 once the mail is at the provider. */
const deliverRoute =
  (deliver: (count: number) => void) => async (request: IncomingMessage, response: ServerResponse) => {
    const body = request.method === 'POST' ? await readJson(request).catch(() => undefined) : undefined
    const count = typeof body === 'object' && body !== null && 'count' in body ? body.count : undefined
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > MAX_DELIVER) {
      response.statusCode = 400
      return response.end(`POST a JSON body { "count": n } with a whole number n from 1 to ${MAX_DELIVER}.`)
    }
    deliver(count)
    response.statusCode = 204
    response.end()
  }

/**
 * Starts the server on 127.0.0.1. Vite runs as middleware on a server the dev host owns, so
 * Vite neither picks the port nor exits the process on a signal. Resolves once it listens.
 */
export async function startServer(options: ServerOptions): Promise<DevServer> {
  const http = createHttpServer()
  const relay = options.relay ? coreRelay(options.paths, options.sim.now, options.coreFlags ?? (() => [])) : undefined
  const sockets = new WebSocketServer({ noServer: true })
  if (relay) sockets.on('connection', relay.connect)

  const renderer = join(options.paths.root, 'apps/desktop/renderer')
  const vite = await createViteServer({
    configFile: join(renderer, 'vite.config.ts'),
    root: renderer,
    appType: 'spa',
    clearScreen: false,
    logLevel: 'warn',
    define: options.sim ? { 'import.meta.env.VITE_LETTERBOX_NOW': JSON.stringify(options.sim.now) } : {},
    server: { middlewareMode: true, hmr: { server: http } },
  })

  const deliver = options.sim && deliverRoute(options.sim.deliver)
  http.on('request', (request, response) => {
    if (new URL(request.url ?? '/', 'http://host').pathname !== '/dev/deliver')
      return vite.middlewares(request, response)
    if (deliver) return void deliver(request, response)
    response.statusCode = 404
    response.end('This dev host runs no sim provider, so it cannot deliver mail.')
  })
  // Vite answers its own HMR upgrades and leaves every other path alone.
  http.on('upgrade', (request, socket, head) => {
    if (new URL(request.url ?? '/', 'http://host').pathname !== '/core') return
    if (!relay) return void socket.destroy()
    sockets.handleUpgrade(request, socket, head, (client) => sockets.emit('connection', client, request))
  })

  const port = await listen(http, options.port)
  return {
    url: `http://127.0.0.1:${port}/`,
    close: async () => {
      await relay?.close()
      sockets.close()
      await vite.close()
      http.closeAllConnections()
      await new Promise((resolve) => http.close(resolve))
    },
  }
}
