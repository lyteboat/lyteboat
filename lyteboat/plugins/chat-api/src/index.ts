/**
 * @lyteboat/chat-api — `/chat`, a business caller's entry to lyteboat's agents,
 * on the host's web server beside `GET /health` and `GET /agents`. Each
 * message goes through dsh's session controller in process: a new session is
 * created under the requested agent, a continued one is checked against the
 * caller and the agent it runs under, and the message is queued with its
 * request (owner, trace id, context) on its source (`requestContext.sourceFields`,
 * through the kernel extension session-controller-prompt-source). The answer
 * returns as one JSON body or as an enterprise event stream (SSE), its cards
 * placed where the answer puts them, as `a2ui.turnParts` lays the turn out.
 *
 * `auth: none` serves only a loopback listener; any other listener needs
 * `shared-secret`, a bearer token resolved from `credentialRef` per request.
 * @module @lyteboat/chat-api
 */

import { randomUUID, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import { brandString } from '@deepseek-ai/dsh-brand'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { AnonymousEntries, ScopedLayers, scopeOf } from '@deepseek-ai/dsh-scope'
import type { ScopeLayer } from '@deepseek-ai/dsh-scope'
import type { LyteboatTurnPart } from '@lyteboat/a2ui'
import type { AgentCatalogEntry } from '@lyteboat/agent-catalog'
import type { JsonValue, LyteboatAgentIdentity, LyteboatRequestState } from '@lyteboat/contracts'
import type {} from '@lyteboat/request-context'
import { ChatApiError, parseChatRequest, readChatBody, type ChatRequest } from './chat-request.ts'
import { isChatSessionOwner } from './chat-session-owner.ts'
import { watchChatTurn, type ChatToolCall, type ChatTurnResult } from './chat-turn.ts'
import { ChatEnterpriseWriter, sseFrame, type ChatFrameContext, type ChatFrameDecorator } from './enterprise-frames.ts'

export type { ChatEnterpriseEvent, ChatEnterpriseFrame, ChatEnterpriseFrameData, ChatFrameContext, ChatFrameDecorator, ChatUiProtocol } from './enterprise-frames.ts'
export type { ChatApiErrorCode } from './chat-request.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    chatApi: ChatApiService
  }
}

export interface Config {
  /** `shared-secret`: `Authorization: Bearer <secret>`; `none`: only on a loopback listener. */
  auth: 'shared-secret' | 'none'
  /** The environment variable (credential reference) that holds the shared secret. */
  credentialRef?: string
  /** The largest request body accepted. */
  maxBodyBytes?: number
  /** How often an open stream sends a `: keep-alive` comment. */
  keepAliveMs?: number
}

const Config: z<Config> = z.object({
  auth: z.union([z.const('shared-secret' as const), z.const('none' as const)]).required(),
  credentialRef: z.string(),
  maxBodyBytes: z.natural().default(1024 * 1024),
  keepAliveMs: z.natural().default(15_000),
})

const CHAT_API_CONFIG_KEYS = new Set(['auth', 'credentialRef', 'maxBodyBytes', 'keepAliveMs'])

class FrameDecoratorLayer implements ScopeLayer {
  readonly entries = new AnonymousEntries<ChatFrameDecorator>()

  isEmpty(): boolean {
    return this.entries.isEmpty()
  }
}

/** A card as a `/chat` answer carries it. */
interface ChatCard {
  area: string
  surface_id: string
  a2ui: JsonValue
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(body))
}

/** The answer text of a turn's parts, cards left out. */
function answerOf(parts: readonly LyteboatTurnPart[]): string {
  return parts.map(part => part.kind === 'text' ? part.text : '').join('')
}

function cardsOf(parts: readonly LyteboatTurnPart[]): ChatCard[] {
  return parts.flatMap(part => part.kind === 'card' ? [{ area: part.card.area, surface_id: part.card.surfaceId, a2ui: part.card.payload }] : [])
}

/** Host service: the `/chat` endpoint and the frame decorators agents register. */
export class ChatApiService extends Service {
  static inject = ['webServer', 'sessionController', 'agentCatalog', 'requestContext', 'a2ui', 'credentials']
  // The loader applies a class plugin's static Config, not the module's.
  static Config = Config

  private readonly decorators = new ScopedLayers(() => new FrameDecoratorLayer(), () => {})
  /** Messages being answered, by `<session>\0<message>`: the session controller would accept a retry silently. */
  private readonly inFlight = new Set<string>()

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'chatApi')
    // schemastery passes unknown keys through; a misspelt or retired one (`workspace`) must not be ignored.
    const unknown = Object.keys(config).filter(key => !CHAT_API_CONFIG_KEYS.has(key))
    if (unknown.length > 0) {
      throw new Error(`chat-api: unknown config key${unknown.length > 1 ? 's' : ''} ${unknown.map(key => JSON.stringify(key)).join(', ')}; allowed: ${[...CHAT_API_CONFIG_KEYS].join(', ')}`)
    }
    if (config.auth === 'none' && ctx.webServer.host !== '127.0.0.1') {
      throw new Error('chat-api: auth none serves only a 127.0.0.1 listener; set auth: shared-secret and a credentialRef to listen on other interfaces')
    }
    if (config.auth === 'shared-secret' && (config.credentialRef ?? '') === '') {
      throw new Error('chat-api: auth shared-secret needs a credentialRef, the environment variable that holds the secret')
    }
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/chat', handler: (request, response) => this.chat(request, response) }), 'chat-api: /chat')
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/health', handler: (_request, response) => { sendJson(response, 200, { status: 'ok' }) } }), 'chat-api: /health')
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/agents', handler: (request, response) => this.agents(request, response) }), 'chat-api: /agents')
  }

  /**
   * Register a frame decorator in the calling scope (an agent's standing
   * scope): every frame answering that agent's sessions passes through it.
   * It may add fields to a frame's `data`; changing a field the protocol owns
   * fails the frame.
   * @returns the exact disposer that withdraws it.
   */
  registerFrameDecorator(decorator: ChatFrameDecorator): () => void {
    return this.decorators.effect(
      this.ctx,
      layer => layer.entries.append(decorator),
      { label: 'chatApi.registerFrameDecorator()', notify: false },
    )
  }

  /** The decorators one agent's frames pass through, the host's first. */
  private decoratorsFor(agent: Agent): ChatFrameDecorator[] {
    return [this.decorators.global, ...this.decorators.chainLayers(scopeOf(agent.ctx))].flatMap(layer => [...layer.entries.values()])
  }

  /** Wait until the catalog has declared its agents, whether or not every one mounted. */
  private async catalogSettled(): Promise<void> {
    try {
      await this.ctx.agentCatalog.whenReady()
    } catch {
      // A failed agent is listed in failures() and answers agent_not_found; the ones that mounted still answer.
    }
  }

  private async authorize(request: IncomingMessage): Promise<void> {
    if (this.config.auth === 'none') return
    const resolved = await this.ctx.credentials.resolve(credentialRef(this.config.credentialRef ?? ''))
    if (resolved === undefined) throw new ChatApiError('internal', 'the shared secret is not configured', false)
    const presented = /^Bearer (.+)$/u.exec(request.headers.authorization ?? '')?.[1] ?? ''
    const expected = Buffer.from(resolved.value)
    const given = Buffer.from(presented)
    if (given.byteLength !== expected.byteLength || !timingSafeEqual(given, expected)) {
      throw new ChatApiError('unauthorized', 'missing or wrong bearer token')
    }
  }

  private async agents(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      await this.authorize(request)
      await this.catalogSettled()
      sendJson(response, 200, {
        agents: this.ctx.agentCatalog.list().map(agent => ({ id: agent.id, name: agent.name ?? agent.id, ...agent.description === undefined ? {} : { description: agent.description }, ...agent.identity.version === undefined ? {} : { version: agent.identity.version } })),
        failures: this.ctx.agentCatalog.failures().map(failure => ({ id: failure.id, reason: failure.reason })),
      })
    } catch (error: unknown) {
      this.refuse(response, error)
    }
  }

  private refuse(response: ServerResponse, error: unknown): void {
    const refusal = error instanceof ChatApiError ? error : new ChatApiError('internal', error instanceof Error ? error.message : String(error))
    if (refusal.code === 'internal') this.ctx.logger.warn(`chat-api: ${refusal.message}`)
    sendJson(response, refusal.status, refusal.body())
  }

  /** The session a request continues or starts, after checking the caller and the agent. */
  private async sessionFor(request: ChatRequest, agent: AgentCatalogEntry, messageId: string): Promise<SessionId> {
    if (request.sessionId === undefined) {
      const created = await this.ctx.sessionController.create({ cwd: agent.workdir, agentPreset: agent.id })
      return created.sessionId
    }
    const sessionId = brandString<SessionId>(request.sessionId)
    const projections = await this.ctx.sessionController.projections({ sessionId }, new AbortController().signal)
    const owner = (projections?.values['lyteboatRequest'] as Partial<LyteboatRequestState> | undefined)?.owner
    // A session the caller does not own answers as one that does not exist.
    if (projections === null || !isChatSessionOwner(owner, request.userId)) {
      throw new ChatApiError('session_not_found', `session ${JSON.stringify(sessionId)} does not exist`)
    }
    const agentPreset = projections.values['agentPreset']
    if (agentPreset !== request.agentId) {
      throw new ChatApiError('agent_mismatch', `session ${JSON.stringify(sessionId)} runs agent ${JSON.stringify(agentPreset ?? null)}, not ${JSON.stringify(request.agentId)}`)
    }
    const inspection = await this.ctx.sessionController.inspect(sessionId)
    const seen = inspection.events.some(event => event.type === 'user/message' && (event.data.source as { rpcId?: unknown }).rpcId === messageId)
    if (seen) throw new ChatApiError('message_duplicate', `message ${JSON.stringify(messageId)} was already sent in this session`)
    return sessionId
  }

  private async chat(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== 'POST') {
      sendJson(response, 405, new ChatApiError('invalid_request', 'use POST').body())
      return
    }
    let key: string | undefined
    try {
      await this.authorize(request)
      const chat = parseChatRequest(await readChatBody(request, this.config.maxBodyBytes ?? 1024 * 1024))
      await this.catalogSettled()
      const agent = this.ctx.agentCatalog.get(chat.agentId)
      if (agent === undefined) throw new ChatApiError('agent_not_found', `no agent ${JSON.stringify(chat.agentId)}`)
      const messageId = chat.messageId ?? randomUUID()
      if (chat.sessionId !== undefined && this.inFlight.has(`${chat.sessionId}\0${messageId}`)) {
        throw new ChatApiError('message_duplicate', `message ${JSON.stringify(messageId)} is already being answered`)
      }
      const sessionId = await this.sessionFor(chat, agent, messageId)
      key = `${sessionId}\0${messageId}`
      if (this.inFlight.has(key)) throw new ChatApiError('message_duplicate', `message ${JSON.stringify(messageId)} is already being answered`)
      this.inFlight.add(key)
      const resolved = await this.ctx.sessionController.resolveAgent(sessionId)
      if ('error' in resolved) throw new ChatApiError('internal', resolved.error.message)
      await this.answer(chat, sessionId, messageId, resolved.agent, agent.identity, response)
    } catch (error: unknown) {
      if (!response.headersSent) this.refuse(response, error)
      else if (!response.writableEnded) response.end()
    } finally {
      if (key !== undefined) this.inFlight.delete(key)
    }
  }

  private async answer(chat: ChatRequest, sessionId: SessionId, messageId: string, agent: Agent, identity: LyteboatAgentIdentity, response: ServerResponse): Promise<void> {
    const context: ChatFrameContext = { agentId: chat.agentId, sessionId, messageId, userId: chat.userId }
    const stream = chat.stream ? this.frameStream(response, context, agent) : undefined
    const writer = stream?.writer
    const watch = watchChatTurn(this.ctx, agent, messageId, this.ctx.a2ui.liveTurn(), {
      started: turn => writer?.runStarted(turn),
      reasoning: (think, content) => writer?.reasoning(think, content),
      parts: (parts) => {
        for (const part of parts) {
          if (part.kind === 'text') writer?.text(part.text)
          else writer?.card(part.card.payload)
        }
      },
    })
    const aborted = new AbortController()
    const onClose = (): void => {
      if (response.writableFinished) return
      aborted.abort()
      if (!watch.running) return
      this.cancelTurn(agent, sessionId).catch((error: unknown) => {
        this.ctx.logger.warn(`chat-api: cancelling ${sessionId} after the caller left failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    }
    // The request emits `close` as soon as its body is read; the response's
    // `close` before it finished is the caller leaving.
    response.on('close', onClose)
    let keepAlive: ReturnType<typeof setInterval> | undefined
    try {
      await this.ctx.sessionController.prompt({
        requestId: brandString<SessionRequestId>(messageId),
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: chat.message }],
        sourceFields: this.ctx.requestContext.sourceFields({ requestId: messageId, owner: { kind: 'user', id: chat.userId }, agent: identity, ...chat.traceId === undefined ? {} : { traceId: chat.traceId }, ...chat.context === undefined ? {} : { context: chat.context } }),
      }, aborted.signal)
      if (stream !== undefined) {
        stream.open()
        keepAlive = setInterval(() => { response.write(': keep-alive\n\n') }, this.config.keepAliveMs ?? 15_000)
      }
      const ended = await Promise.race([watch.result, new Promise<undefined>((resolve) => { aborted.signal.addEventListener('abort', () => { resolve(undefined) }) })])
      if (ended === undefined) return
      if (writer === undefined) {
        sendJson(response, 200, this.body(sessionId, messageId, ended))
      } else {
        if (ended.outcome === 'errored') writer.fail(ended.error ?? 'the turn failed', true)
        else writer.finish(ended.outcome)
        response.end()
      }
    } catch (error: unknown) {
      if (stream === undefined || !stream.opened || stream.writer.done) throw error
      stream.writer.fail(error instanceof Error ? error.message : String(error), false)
      response.end()
    } finally {
      if (keepAlive !== undefined) clearInterval(keepAlive)
      watch.dispose()
      response.off('close', onClose)
    }
  }

  /**
   * Cancel the running turn of a caller that left. dsh's cancel keeps the
   * queue but parks it until the next wake, and every message queued behind
   * the cancelled one has a caller waiting for its turn: once the agent is
   * idle, the parked messages are queued again, in order, which wakes it.
   */
  private async cancelTurn(agent: Agent, sessionId: SessionId): Promise<void> {
    this.ctx.sessionController.cancel({ sessionId })
    await agent.whenIdle()
    if (agent.status !== 'idle') return
    // A removed message is recorded as cancelled, so each returns under a new identity.
    for (const { id: _cancelled, role: _role, ...message } of agent.inbox.splice('next-turn', 0, Infinity, [])) agent.followup(createUserMessage(message))
  }

  /**
   * The stream of one answer. It opens once the session controller accepted the
   * message, so a refused message is answered with its HTTP status; the turn may
   * start before that, and its first frames wait for the stream to open.
   */
  private frameStream(response: ServerResponse, context: ChatFrameContext, agent: Agent): { writer: ChatEnterpriseWriter; readonly opened: boolean; open(): void } {
    const waiting: string[] = []
    let opened = false
    const writer = new ChatEnterpriseWriter({
      context,
      decorators: this.decoratorsFor(agent),
      send: (frame) => {
        if (opened) response.write(sseFrame(frame))
        else waiting.push(sseFrame(frame))
      },
      now: () => new Date(),
    })
    return {
      writer,
      get opened() { return opened },
      open: () => {
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' })
        response.flushHeaders()
        opened = true
        for (const frame of waiting.splice(0)) response.write(frame)
      },
    }
  }

  private body(sessionId: string, messageId: string, ended: ChatTurnResult): { session_id: string; message_id: string; outcome: string; response: string; cards: ChatCard[]; tool_calls: ChatToolCall[]; error?: string } {
    return {
      session_id: sessionId,
      message_id: messageId,
      outcome: ended.outcome,
      response: answerOf(ended.parts),
      cards: cardsOf(ended.parts),
      tool_calls: ended.toolCalls,
      ...ended.error === undefined ? {} : { error: ended.error },
    }
  }
}

export default ChatApiService
