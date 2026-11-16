// The window and everything that limits what its page may do: the sandbox, the content
// security policy, no navigation, no new windows, no permissions.

import { join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, net, protocol, session } from 'electron'
import type { Renderer } from './config.ts'
import { log } from './log.ts'

/** The scheme a built renderer is served on, as app://renderer/index.html. */
const SCHEME = 'app'
const HOST = 'renderer'

/** The window's colour before the page paints: the design's window background. */
const BACKGROUND = '#0f0f11'

/**
 * Where macOS draws the traffic lights: in the sidebar's top band, on the line every pane's
 * first element starts on, 36px down (the renderer's `top-band` in styles.css), and 18px
 * across, the sidebar's own left gutter.
 */
const TRAFFIC_LIGHTS = { x: 18, y: 36 }

/** The policy for a built renderer: its own files only, nothing remote, no inline script. */
const CSP_BUILT = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ')

/**
 * The policy for the dev server. Vite injects inline scripts (React Refresh) and styles, and
 * its HMR socket and the dev hooks talk to the same origin.
 */
const cspForServer = (url: URL) =>
  [
    "default-src 'none'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    `connect-src 'self' ws://${url.host}`,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ')

/** Lets app:// load ES modules and use V8's code cache. Call before the app is ready. */
export function registerScheme() {
  protocol.registerSchemesAsPrivileged([
    { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } },
  ])
}

/** Serves `renderer` with its policy, and denies every permission. Call once the app is ready. Returns the page URL. */
export function serveRenderer(renderer: Renderer): string {
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, answer) => answer(false))
  session.defaultSession.setPermissionCheckHandler(() => false)

  if (renderer.kind === 'server') {
    const csp = cspForServer(renderer.url)
    session.defaultSession.webRequest.onHeadersReceived({ urls: [`${renderer.url.origin}/*`] }, (details, done) =>
      done({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] } }),
    )
    return renderer.url.href
  }

  const root = renderer.folder
  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url)
    const file = resolve(root, `.${decodeURIComponent(url.pathname)}`)
    const inside = file === root || relative(root, file).split(sep)[0] !== '..'
    if (url.host !== HOST || !inside) return new Response('not found', { status: 404 })
    const response = await net.fetch(pathToFileURL(file).href)
    const headers = new Headers(response.headers)
    headers.set('Content-Security-Policy', CSP_BUILT)
    return new Response(response.body, { status: response.status, headers })
  })
  return `${SCHEME}://${HOST}/index.html`
}

/** The origin of `url` as Chromium writes it, app://renderer included, which URL#origin calls 'null'. */
const originOf = (url: string) => {
  const parsed = URL.parse(url)
  return parsed && `${parsed.protocol}//${parsed.host}`
}

/** The origin the page loads from. Main gives a core only to a frame of this origin. */
export const pageOrigin = (renderer: Renderer) =>
  renderer.kind === 'server' ? renderer.url.origin : `${SCHEME}://${HOST}`

/**
 * Keeps every page where it is: no navigation away, no redirect to another origin, no new
 * windows, no webviews. A redirect would load the page elsewhere with the bridge but
 * without the policy.
 */
export function lockNavigation(origin: string) {
  app.on('web-contents-created', (_event, contents) => {
    // A reload asks to go to the URL it is on. Vite's HMR does that, and so may a person.
    contents.on('will-navigate', (event, url) => {
      if (url !== contents.getURL()) event.preventDefault()
    })
    contents.on('will-redirect', (event, url) => {
      if (originOf(url) === origin) return
      event.preventDefault()
      log(`blocked a redirect to ${originOf(url) ?? 'a url that does not parse'}`)
    })
    contents.on('will-attach-webview', (event) => event.preventDefault())
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  })
}

/** Opens the window hidden, and shows it once the page has painted. */
export function createWindow(url: string, preloadFolder: string) {
  const mac = process.platform === 'darwin'
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 640,
    minHeight: 420,
    show: false,
    backgroundColor: BACKGROUND,
    // macOS draws the traffic lights over the page and puts native vibrancy behind it. The
    // page makes its sidebar transparent there (window.letterbox.platform is 'darwin').
    ...(mac && { titleBarStyle: 'hiddenInset', trafficLightPosition: TRAFFIC_LIGHTS, vibrancy: 'sidebar' }),
    webPreferences: {
      preload: join(preloadFolder, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })
  window.once('ready-to-show', () => window.show())
  void window.loadURL(url)
  return window
}
