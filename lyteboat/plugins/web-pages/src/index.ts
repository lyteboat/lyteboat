/**
 * @lyteboat/web-pages — lyteboat's pages in dsh web. The Host face answers
 * the pages at `/api/lyteboat/<endpoint>` on dsh's connection, behind the same
 * trust fence and login as every dsh web request, in dsh's RPC envelopes so
 * the pages call it through dsh's own browser transport: the agents the
 * catalog serves and the ones that failed, a reload of the catalog, a message
 * sent with its request context, the eval runs and one run's report. A message
 * goes through dsh's session controller with its request on the source, the
 * path a `/chat` message takes, so its answer shows in dsh's own conversation.
 * The client face (`./client`) is the pages; a session's lyteboat state reaches
 * them through dsh's projection hooks, not through this face.
 * @module @lyteboat/web-pages
 */

import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import { brandString } from '@deepseek-ai/dsh-brand'
import { clientRequestSchema, type ConnectionRpcHandlerResult, type ServerResponse } from '@deepseek-ai/dsh-client-connection'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@lyteboat/agent-catalog'
import type {} from '@lyteboat/request-context'
import { z as zod } from 'zod'
import { listEvalRuns, readEvalReport } from './eval-runs.ts'
import {
  WEB_PAGES_ENDPOINTS, WEB_PAGES_METHOD_PREFIX,
  type WebPagesAgentsAnswer, type WebPagesEvalReportAnswer, type WebPagesEvalsAnswer, type WebPagesEndpoint, type WebPagesSendAnswer,
} from './web-pages-endpoints.ts'

export type { WebPagesAgentsAnswer, WebPagesEvalReportAnswer, WebPagesEvalRun, WebPagesEvalsAnswer, WebPagesEndpoint, WebPagesSendAnswer, WebPagesSendRequest } from './web-pages-endpoints.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    webPages: WebPagesService
  }
}

export interface Config {
  /** The request owner a message the pages send records. */
  owner?: string
  /** Where the eval runs are; default `$LYTEBOAT_HOME/evals`. */
  evalsDir?: string
}

const Config: z<Config> = z.object({
  owner: z.string().default('web'),
  evalsDir: z.string(),
})

/** A refusal the page shows. */
class WebPagesRefusal extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
  }
}

const sendPayload = zod.strictObject({
  sessionId: zod.string().min(1),
  text: zod.string().refine((text: string) => text.trim() !== '', 'text must not be blank'),
  context: zod.record(zod.string(), zod.json()).optional(),
})
const reportPayload = zod.strictObject({ run: zod.string().min(1) })

function parse<T>(schema: zod.ZodType<T>, payload: unknown): T {
  const parsed = schema.safeParse(payload)
  if (parsed.success) return parsed.data
  const issue = parsed.error.issues[0]
  throw new WebPagesRefusal('invalid_request', issue === undefined ? 'invalid payload' : `${issue.path.join('.') || 'payload'}: ${issue.message}`)
}

/** Host service: the endpoints the web pages call. */
export class WebPagesService extends Service {
  static inject = ['connection', 'sessionController', 'agentCatalog', 'requestContext']
  // The loader applies a class plugin's static Config, not the module's.
  static Config = Config

  constructor(ctx: Context, private readonly config: Config = {}) {
    super(ctx, 'webPages')
    // Exact routes on dsh's `/api` channel: `rpc.handle` would mount a channel of
    // its own through the connection's web server, which a plugin row cannot reach.
    for (const endpoint of WEB_PAGES_ENDPOINTS) {
      const route = { path: `/api/${WEB_PAGES_METHOD_PREFIX}/${endpoint}`, methods: ['POST' as const], requestBody: 'buffered' as const, fetch: (request: Request) => this.serve(endpoint, request) }
      ctx.effect(() => ctx.connection.fetch.register(route), `web-pages: ${route.path}`)
    }
  }

  /** Answer one call in dsh's RPC envelopes, as `connection.rpc.call` expects. */
  private async serve(endpoint: WebPagesEndpoint, request: Request): Promise<Response> {
    const body: unknown = await request.json().catch(() => undefined)
    const envelope = clientRequestSchema.safeParse(body)
    if (!envelope.success || envelope.data.method !== `${WEB_PAGES_METHOD_PREFIX}/${endpoint}`) return new Response('invalid client-request message', { status: 400 })
    const result = await this.answer(endpoint, envelope.data.payload, request.signal)
    return Response.json({ type: 'server-response', rpcId: envelope.data.rpcId, result } satisfies ServerResponse)
  }

  private async answer(endpoint: WebPagesEndpoint, payload: unknown, signal: AbortSignal): Promise<ConnectionRpcHandlerResult> {
    try {
      return { ok: true, value: await this.endpoint(endpoint, payload, signal) }
    } catch (error: unknown) {
      const refusal = error instanceof WebPagesRefusal ? error : new WebPagesRefusal('internal', error instanceof Error ? error.message : String(error))
      if (refusal.code === 'internal') this.ctx.logger.warn(`web pages: ${endpoint}: ${refusal.message}`)
      return { ok: false, error: { code: refusal.code, message: refusal.message, details: {} } }
    }
  }

  private async endpoint(endpoint: WebPagesEndpoint, payload: unknown, signal: AbortSignal): Promise<WebPagesAgentsAnswer | WebPagesSendAnswer | WebPagesEvalsAnswer | WebPagesEvalReportAnswer> {
    switch (endpoint) {
      case 'agents': return this.agents()
      case 'agents/reload':
        // A failed agent is reported with the rest; the reload itself answers.
        await this.ctx.agentCatalog.reload().catch(() => {})
        return this.agents()
      case 'session/send': return this.send(parse(sendPayload, payload), signal)
      case 'evals': return { runs: listEvalRuns(this.evalsDir(), message => { this.ctx.logger.warn(message) }) }
      case 'evals/report': {
        const { run } = parse(reportPayload, payload)
        try {
          return { run, report: readEvalReport(this.evalsDir(), run) }
        } catch (error: unknown) {
          throw new WebPagesRefusal('not_found', error instanceof Error ? error.message : String(error))
        }
      }
    }
  }

  private evalsDir(): string {
    return this.config.evalsDir ?? dshHomePath('evals')
  }

  private async agents(): Promise<WebPagesAgentsAnswer> {
    await this.ctx.agentCatalog.whenReady().catch(() => {})
    return {
      agents: this.ctx.agentCatalog.list().map(agent => ({ id: agent.id, name: agent.name ?? agent.id, ...agent.description === undefined ? {} : { description: agent.description } })),
      failures: this.ctx.agentCatalog.failures().map(failure => ({ id: failure.id, reason: failure.reason })),
    }
  }

  /** Queue a message with its request context, the way `/chat` does. */
  private async send(message: zod.infer<typeof sendPayload>, signal: AbortSignal): Promise<WebPagesSendAnswer> {
    const requestId = randomUUID()
    await this.ctx.sessionController.prompt({
      requestId: brandString<SessionRequestId>(requestId),
      sessionId: brandString<SessionId>(message.sessionId),
      mode: 'queue',
      content: [{ type: 'text', text: message.text }],
      sourceFields: this.ctx.requestContext.sourceFields({ requestId, owner: { kind: 'operator', id: this.config.owner ?? 'web' }, ...message.context === undefined ? {} : { context: message.context } }),
    }, signal)
    return { requestId }
  }
}

export default WebPagesService
