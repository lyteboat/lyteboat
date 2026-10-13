/**
 * @lyteboat/studio-web — the Studio's pages, a React single-page app built
 * into `lib/web` (`scripts/dist/build-studio-web.ts`), served under `/studio`
 * on the host web server. A file under `/studio/assets/` is served as built
 * (its name carries its hash, so it is cached for good) or answered 404; any
 * other path answers the app's `index.html`, whose router shows the page. Every
 * answer carries a CSP that lets the pages load only their own scripts and
 * styles and talk only to their own origin, and `/` redirects to the Studio.
 * The pages call `@lyteboat/studio-api`; this row serves files and nothing else.
 * One kind of file is an agent's rather than the build's: while `agentCatalog`
 * is mounted, `/studio/agents/<id>/card-components.js` answers that agent's
 * card components module (`STUDIO_AGENT_CARD_COMPONENTS_FILE` in its
 * directory) as a script, uncached and without sign-in like the pages' own
 * scripts, and 404 for an agent without one, an unknown agent, or a Studio
 * without a catalog. No other file of an agent is reachable.
 * @module @lyteboat/studio-web
 */

import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import z from '@deepseek-ai/schemastery'
import type { AgentCatalogService } from '@lyteboat/agent-catalog'
import { STUDIO_AGENT_CARD_COMPONENTS_FILE } from '@lyteboat/contracts/studio'

/** Where the pages sit on the web server. */
export const STUDIO_WEB_PREFIX = '/studio'

export interface StudioWebConfig {
  /** The built pages; default this package's `lib/web`. */
  webDir?: string
}

// Loaded from src/ (tests) or lib/ (the launcher), the package root is one level up either way.
const BUILT_WEB_DIR = fileURLToPath(new URL('../lib/web/', import.meta.url))

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}

// The pages run only the scripts and styles they were built with, and call only their own origin.
const STUDIO_PAGE_HEADERS = {
  'content-security-policy': 'default-src \'self\'; script-src \'self\'; style-src \'self\'; img-src \'self\' data:; font-src \'self\'; connect-src \'self\'; object-src \'none\'; base-uri \'none\'; form-action \'self\'; frame-ancestors \'none\'',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
} as const

function sendStudioText(response: ServerResponse, status: number, text: string, extra: Record<string, string> = {}): void {
  response.writeHead(status, { ...STUDIO_PAGE_HEADERS, 'content-type': 'text/plain; charset=utf-8', 'content-length': Buffer.byteLength(text), ...extra })
  response.end(text)
}

/** The built file a path under the prefix names, when it exists inside the pages; never one outside them. */
function builtFileOf(webDir: string, path: string): string | undefined {
  let relative: string
  try {
    relative = decodeURIComponent(path)
  } catch {
    return undefined
  }
  if (relative.includes('\0')) return undefined
  const file = resolve(webDir, `.${relative}`)
  if (!file.startsWith(webDir.endsWith(sep) ? webDir : `${webDir}${sep}`)) return undefined
  return existsSync(file) && statSync(file).isFile() ? file : undefined
}

function sendBuiltFile(request: IncomingMessage, response: ServerResponse, file: string, cacheControl: string): void {
  response.writeHead(200, {
    ...STUDIO_PAGE_HEADERS,
    'content-type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream',
    'content-length': statSync(file).size,
    'cache-control': cacheControl,
  })
  if (request.method === 'HEAD') response.end()
  else createReadStream(file).pipe(response)
}

// The pages import it from here (studio-chat-panel); one fixed name, so no path of the agent's reaches the disk.
const AGENT_CARD_COMPONENTS_PATH = /^\/agents\/([^/]+)\/card-components\.js$/u

/** The card components module of the agent a path names, when the path names one and the agent has it. */
function agentCardComponentsOf(catalog: AgentCatalogService | undefined, encodedId: string): string | undefined {
  let id: string
  try {
    id = decodeURIComponent(encodedId)
  } catch {
    return undefined
  }
  const entry = catalog?.get(id)
  if (entry === undefined) return undefined
  const file = join(entry.dir, STUDIO_AGENT_CARD_COMPONENTS_FILE)
  return existsSync(file) && statSync(file).isFile() ? file : undefined
}

export default class StudioWebPages {
  /** The web server the pages are served on. */
  static inject = ['webServer']
  static Config: z<StudioWebConfig> = z.object({
    webDir: z.string(),
  })

  /**
   * Serve the pages under `/studio` and redirect `/` to them.
   * @param ctx - plugin context carrying the web server.
   * @param studioWebConfig - where the built pages are.
   * @throws when the pages are not built.
   */
  constructor(ctx: Context, studioWebConfig: StudioWebConfig) {
    const webDir = resolve(studioWebConfig.webDir ?? BUILT_WEB_DIR)
    if (!existsSync(join(webDir, 'index.html'))) throw new Error(`studio-web: the pages are not built (no ${join(webDir, 'index.html')}); run pnpm run build`)
    const index = readFileSync(join(webDir, 'index.html'))
    let catalog: AgentCatalogService | undefined
    ctx.inject(['agentCatalog'], (catalogCtx) => {
      catalog = catalogCtx.agentCatalog
      catalogCtx.effect(() => () => { catalog = undefined }, 'studio-web: agent card components')
    })
    const handler = (request: IncomingMessage, response: ServerResponse): void => {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        sendStudioText(response, 405, 'use GET', { allow: 'GET, HEAD' })
        return
      }
      const path = new URL(request.url ?? '/', 'http://studio.invalid').pathname.slice(STUDIO_WEB_PREFIX.length)
      const agentModule = AGENT_CARD_COMPONENTS_PATH.exec(path)
      if (agentModule !== null) {
        const file = agentCardComponentsOf(catalog, agentModule[1] ?? '')
        if (file === undefined) sendStudioText(response, 404, 'not found')
        else sendBuiltFile(request, response, file, 'no-cache')
        return
      }
      const file = path === '' || path === '/' ? undefined : builtFileOf(webDir, path)
      if (file !== undefined) {
        sendBuiltFile(request, response, file, path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache')
        return
      }
      // A missing script or stylesheet must not come back as the page: a stale tab would run HTML as code.
      if (path.startsWith('/assets/')) {
        sendStudioText(response, 404, 'not found')
        return
      }
      response.writeHead(200, { ...STUDIO_PAGE_HEADERS, 'content-type': CONTENT_TYPES['.html'] ?? 'text/html', 'content-length': index.byteLength, 'cache-control': 'no-cache' })
      response.end(request.method === 'HEAD' ? undefined : index)
    }
    ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: STUDIO_WEB_PREFIX, handler }), 'studio-web: /studio')
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/', handler: (_request, response) => { sendStudioText(response, 302, 'the Studio is at /studio/', { location: `${STUDIO_WEB_PREFIX}/` }) } }), 'studio-web: /')
  }
}
