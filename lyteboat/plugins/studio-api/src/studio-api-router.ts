/**
 * The Studio API's request pipeline. A request under the prefix passes the
 * Host allowlist (421 otherwise), is matched to one route by its path and
 * method, has its caller resolved and checked against the route's role, and
 * is answered as JSON with the headers every Studio answer carries. A route
 * returns the answer's body or throws {@link StudioApiError}; anything else it
 * throws is answered as `internal` without its message, which goes to the log.
 * @module @lyteboat/studio-api/studio-api-router
 */

import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'
import type { z } from 'zod'
import type { StudioErrorAnswer, StudioErrorCode, StudioPrincipal, StudioRole } from '@lyteboat/contracts/studio'
import type { StudioAuthResult } from '@lyteboat/studio-auth'
import { studioHostAllowed } from './studio-host-allowlist.ts'

/** Who may call a route: anyone, or a caller whose role is at least this one. */
export type StudioApiAccess = 'public' | StudioRole

/** One call as a route sees it. */
export interface StudioApiCall {
  /** The path's `:name` segments, decoded. */
  readonly params: Readonly<Record<string, string>>
  readonly query: URLSearchParams
  /** The caller; absent only on a public route. */
  readonly principal: StudioPrincipal | undefined
  /** The caller's address, for throttling and the audit log. */
  readonly from: string
  readonly headers: IncomingHttpHeaders
  /** The request body, parsed as JSON. */
  body(): Promise<unknown>
}

/** One endpoint: `path` is relative to the prefix, with `:name` segments. */
export interface StudioApiRoute {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  path: string
  access: StudioApiAccess
  handle(call: StudioApiCall): unknown
}

const STATUS_OF_CODE: Readonly<Record<StudioErrorCode, number>> = {
  invalid_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  precondition_failed: 412,
  payload_too_large: 413,
  misdirected: 421,
  too_many_requests: 429,
  internal: 500,
}

/** A refusal a route or the pipeline answers with. */
export class StudioApiError extends Error {
  constructor(readonly code: StudioErrorCode, message: string, readonly status: number = STATUS_OF_CODE[code]) {
    super(message)
  }

  body(): StudioErrorAnswer {
    return { error: { code: this.code, message: this.message } }
  }
}

/**
 * Wait for the agent catalog to settle. Not strict: an agent that failed to
 * mount is in the catalog's failures and is simply not served; the ones that
 * mounted are.
 * @param settling - the catalog's `whenReady()` or `reload()`.
 */
export async function studioCatalogSettled(settling: Promise<void>): Promise<void> {
  try {
    await settling
  } catch {
    // The failure is the failed agents', listed by failures(); nothing else rejects this promise.
  }
}

/**
 * A schema's refusal as one message: every issue, with its path.
 * @param error - the refusal.
 * @param whole - how a path-less issue names the value (`(the body)`).
 */
export function studioSchemaProblems(error: z.ZodError, whole: string): string {
  return error.issues.map(issue => `${issue.path.join('.') || whole}: ${issue.message}`).join('; ')
}

/** Turn a refused result into its error, so a route can throw it. */
export function studioValueOf<T>(result: StudioAuthResult<T>): T {
  if (!result.ok) throw new StudioApiError(result.code, result.message)
  return result.value
}

const ROLE_RANK: Readonly<Record<StudioRole, number>> = { viewer: 0, editor: 1, admin: 2 }

// Every answer is data for the Studio page's own script: never sniffed, framed, cached, or run.
const STUDIO_API_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'content-security-policy': 'default-src \'none\'; frame-ancestors \'none\'',
} as const

/** What the pipeline needs besides its routes. */
interface StudioApiRouterOptions {
  /** The absolute prefix the routes sit under, without a trailing slash. */
  prefix: string
  /** Host header values accepted beside the loopback names. */
  trustedHosts: readonly string[]
  maxBodyBytes: number
  /** Who a request's headers speak for. */
  principal(headers: IncomingHttpHeaders): Promise<StudioAuthResult<StudioPrincipal>>
  /** Report an error a route threw that is not a refusal. */
  internalError(error: unknown): void
}

function sendStudioJson(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  response.writeHead(status, { ...STUDIO_API_HEADERS, 'content-length': Buffer.byteLength(text) })
  response.end(text)
}

async function readStudioBody(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  if (!/^application\/json(?:;|$)/iu.test(request.headers['content-type'] ?? '')) {
    throw new StudioApiError('invalid_request', 'send the body as application/json')
  }
  const tooLarge = new StudioApiError('payload_too_large', `the body is larger than ${String(maxBytes)} bytes`)
  if (Number(request.headers['content-length'] ?? 0) > maxBytes) throw tooLarge
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.byteLength
    if (size > maxBytes) throw tooLarge
    chunks.push(chunk)
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size))) as unknown
  } catch {
    throw new StudioApiError('invalid_request', 'the body is not UTF-8 JSON')
  }
}

function decodedSegments(path: string): string[] {
  try {
    return path.split('/').filter(segment => segment !== '').map(segment => decodeURIComponent(segment))
  } catch {
    throw new StudioApiError('invalid_request', 'the path is not valid percent-encoding')
  }
}

/** The params of a route whose path matches, or undefined. */
function matchStudioPath(pattern: readonly string[], segments: readonly string[]): Record<string, string> | undefined {
  if (pattern.length !== segments.length) return undefined
  const params: Record<string, string> = {}
  for (const [index, part] of pattern.entries()) {
    const segment = segments[index] ?? ''
    if (part.startsWith(':')) params[part.slice(1)] = segment
    else if (part !== segment) return undefined
  }
  return params
}

/** Answers every request under one prefix from a route table. */
export class StudioApiRouter {
  private readonly table: { route: StudioApiRoute; pattern: string[] }[]

  constructor(private readonly options: StudioApiRouterOptions, routes: readonly StudioApiRoute[]) {
    this.table = routes.map(route => ({ route, pattern: route.path.split('/') }))
  }

  /** Answer one request; never throws. */
  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      sendStudioJson(response, 200, await this.answer(request))
    } catch (error: unknown) {
      if (!(error instanceof StudioApiError)) this.options.internalError(error)
      const refusal = error instanceof StudioApiError ? error : new StudioApiError('internal', 'the Studio failed to answer; its log says why')
      request.resume()
      if (!response.headersSent) sendStudioJson(response, refusal.status, refusal.body())
    }
  }

  private async answer(request: IncomingMessage): Promise<unknown> {
    if (!studioHostAllowed(request.headers.host, this.options.trustedHosts)) {
      throw new StudioApiError('misdirected', `this Studio does not answer for host ${JSON.stringify(request.headers.host ?? '')}; start it with --trusted-host for that name`)
    }
    const url = new URL(request.url ?? '/', 'http://studio.invalid')
    const segments = decodedSegments(url.pathname.slice(this.options.prefix.length))
    const matching = this.table.flatMap(({ route, pattern }) => {
      const params = matchStudioPath(pattern, segments)
      return params === undefined ? [] : [{ route, params }]
    })
    if (matching.length === 0) throw new StudioApiError('not_found', `no Studio endpoint ${url.pathname}`)
    const matched = matching.find(({ route }) => route.method === request.method)
    if (matched === undefined) throw new StudioApiError('invalid_request', `use ${matching.map(({ route }) => route.method).join(' or ')}`, 405)
    const { route, params } = matched
    const principal = route.access === 'public' ? undefined : studioValueOf(await this.options.principal(request.headers))
    if (principal !== undefined && route.access !== 'public' && ROLE_RANK[principal.role] < ROLE_RANK[route.access]) {
      throw new StudioApiError('forbidden', `this needs the ${route.access} role; ${principal.userId} is ${principal.role}`)
    }
    return await route.handle({
      params,
      query: url.searchParams,
      principal,
      from: request.socket.remoteAddress ?? 'unknown',
      headers: request.headers,
      body: () => readStudioBody(request, this.options.maxBodyBytes),
    })
  }
}
