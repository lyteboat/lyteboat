/**
 * A scripted DeepSeek Messages server (the Anthropic-compatible protocol
 * dsh-llm-deepseek speaks) for end-to-end tests. Unlike the official mock
 * (one tool name per instance, one fixed success text), the reply is chosen
 * per request from the request itself, so one server can answer the loop's
 * requests, the session-title request, and the skill router's request
 * differently. SSE frames follow the official mock.
 * @module @lyteboat/testing/scripted-model
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

/** One content block of a request message, as far as tests read it. */
export interface ChatBlock {
  type: string
  text?: string
  /** A `tool_use` block's tool. */
  name?: string
  /** A `tool_result` block's content. */
  content?: unknown
}

export interface ChatMessage {
  role: string
  content: ChatBlock[]
}

export interface ChatRequest {
  model?: string
  system?: string
  messages: ChatMessage[]
  tools?: { name: string }[]
  [key: string]: unknown
}

/** Why a request was made, inferred from its system text. */
export type RequestPurpose = 'loop' | 'title' | 'router'

export interface RecordedRequest {
  purpose: RequestPurpose
  body: ChatRequest
  /** The last user-role message's text; a message holding only tool results has none. */
  lastUser: string
  /**
   * What the caller wrote last: the last text block of the last user-role message
   * that is not dsh's runtime context. Consecutive human messages (one after a
   * cancelled turn) share one request message, and dsh appends its runtime context
   * to it, so `lastUser` holds all of them.
   */
  latestMessage: string
  /** The request's system prompt and every system update in its history. */
  systemText: string
  /** The tools the request offers, by name, in request order. */
  toolNames: string[]
  /** The tools the history's assistant messages called, by name, in call order. */
  calledTools: string[]
}

export type ScriptedReply =
  | { text: string }
  | { toolCall: { name: string; arguments: unknown; id?: string } }

/** Chooses the reply to one request; a promise holds the reply until it settles. */
export type Script = (request: RecordedRequest) => ScriptedReply | Promise<ScriptedReply>

export interface ScriptedModel {
  /** Base URL without `/v1`; `/v1/messages` is served. */
  baseURL: string
  requests: RecordedRequest[]
  loopRequests(): RecordedRequest[]
  close(): Promise<void>
}

/** The sentence dsh-system-prompt's `joinContextSections` opens every runtime-context snapshot with. */
const DSH_RUNTIME_CONTEXT_OPENING = 'Current runtime context.'

function textOf(blocks: readonly ChatBlock[]): string {
  return blocks.filter(block => block.type === 'text').map(block => block.text ?? '').join('')
}

function classify(body: ChatRequest): RecordedRequest {
  const updates = body.messages.filter(message => message.role === 'system').map(message => textOf(message.content))
  const systemText = [body.system ?? '', ...updates].filter(text => text !== '').join('\n')
  const users = body.messages.filter(message => message.role === 'user' && message.content.some(block => block.type === 'text'))
  const lastUserTexts = users.at(-1)?.content.filter(block => block.type === 'text').map(block => block.text ?? '') ?? []
  const lastUser = lastUserTexts.join('')
  const latestMessage = lastUserTexts.filter(text => !text.startsWith(DSH_RUNTIME_CONTEXT_OPENING)).at(-1) ?? ''
  const toolNames = (body.tools ?? []).map(tool => tool.name)
  const calledTools = body.messages
    .filter(message => message.role === 'assistant')
    .flatMap(message => message.content.filter(block => block.type === 'tool_use').map(block => block.name ?? ''))
  let purpose: RequestPurpose = 'loop'
  if (/concise title/iu.test(systemText)) purpose = 'title'
  else if (/skill 路由器/u.test(systemText)) purpose = 'router'
  return { purpose, body, lastUser, latestMessage, systemText, toolNames, calledTools }
}

async function readJson(request: IncomingMessage): Promise<ChatRequest> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array))
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as ChatRequest
}

function sse(response: ServerResponse, payload: unknown): void {
  response.write(`data: ${JSON.stringify(payload)}\n\n`)
}

function writeReply(response: ServerResponse, reply: ScriptedReply): void {
  response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' })
  response.flushHeaders()
  sse(response, { type: 'message_start', message: { id: 'scripted-message', type: 'message', role: 'assistant', model: 'scripted-model', content: [], usage: { input_tokens: 3, output_tokens: 0 } } })
  if ('text' in reply) {
    sse(response, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
    for (const chunk of Array.from(reply.text)) {
      sse(response, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: chunk } })
    }
    sse(response, { type: 'content_block_stop', index: 0 })
    sse(response, { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: Array.from(reply.text).length } })
  } else {
    const args = typeof reply.toolCall.arguments === 'string' ? reply.toolCall.arguments : JSON.stringify(reply.toolCall.arguments)
    const midpoint = Math.max(1, Math.floor(args.length / 2))
    sse(response, { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: reply.toolCall.id ?? 'scripted-call-1', name: reply.toolCall.name, input: {} } })
    for (const partial of [args.slice(0, midpoint), args.slice(midpoint)]) {
      sse(response, { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: partial } })
    }
    sse(response, { type: 'content_block_stop', index: 0 })
    sse(response, { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 2 } })
  }
  sse(response, { type: 'message_stop' })
  response.end()
}

/**
 * Start the scripted model.
 * @param script - chooses the reply for each request.
 * @param options - optional exact API key (`x-api-key`).
 * @returns the listening server on an OS-assigned port.
 */
export async function startScriptedModel(script: Script, options: { apiKey?: string } = {}): Promise<ScriptedModel> {
  const requests: RecordedRequest[] = []
  const server: Server = createServer((request, response) => {
    void (async () => {
      if (request.method !== 'POST' || !new URL(request.url ?? '/', 'http://scripted.invalid').pathname.endsWith('/v1/messages')) {
        response.writeHead(404, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'not found' } }))
        return
      }
      if (options.apiKey !== undefined && request.headers['x-api-key'] !== options.apiKey) {
        response.writeHead(401, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'unauthorized' } }))
        return
      }
      const recorded = classify(await readJson(request))
      requests.push(recorded)
      const reply = await script(recorded)
      // A held reply may outlive the caller, who aborted the request.
      if (response.destroyed) return
      writeReply(response, reply)
    })().catch((error: unknown) => {
      if (response.headersSent) return
      response.writeHead(500, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: String(error) } }))
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('scripted model: no TCP address')
  return {
    baseURL: `http://127.0.0.1:${String(address.port)}`,
    requests,
    loopRequests: () => requests.filter(request => request.purpose === 'loop'),
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => { resolve() }) }),
  }
}

/**
 * The environment that points dsh's DeepSeek provider at a local model server
 * (a scripted model, or dsh's own mock server) with telemetry off. The key is
 * `mock-key`, the one the repository's tests start their servers with.
 * @param server - the listening server; `/v1` is appended to its base URL.
 * @returns `DEEPSEEK_BASE_URL`, `DEEPSEEK_API_KEY`, and `DSH_TELEMETRY_DISABLED`.
 */
export function scriptedModelEnv(server: { readonly baseURL: string }): Record<string, string> {
  return { DEEPSEEK_BASE_URL: `${server.baseURL}/v1`, DEEPSEEK_API_KEY: 'mock-key', DSH_TELEMETRY_DISABLED: '1' }
}

/** A script that answers the title request with a fixed title and everything else through `loop`. */
export function withTitle(loop: Script, title = 'scripted title'): Script {
  return (request) => (request.purpose === 'title' ? { text: title } : loop(request))
}
