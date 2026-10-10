/**
 * The `/chat` request: its body, read bounded and checked, and the refusals
 * the endpoint answers with an HTTP status before any stream starts.
 * @module @lyteboat/chat-api/chat-request
 */

import type { IncomingMessage } from 'node:http'
import { z } from 'zod'
import type { JsonValue, LyteboatRequestOwner } from '@lyteboat/contracts'

/** Why a request was refused before its stream started. */
export type ChatApiErrorCode =
  | 'invalid_request'
  | 'unauthorized'
  | 'agent_not_found'
  | 'session_not_found'
  | 'message_duplicate'
  | 'agent_mismatch'
  | 'body_too_large'
  | 'internal'

const STATUS: Readonly<Record<ChatApiErrorCode, number>> = {
  invalid_request: 400,
  unauthorized: 401,
  agent_not_found: 404,
  session_not_found: 404,
  message_duplicate: 409,
  agent_mismatch: 409,
  body_too_large: 413,
  internal: 500,
}

/** A refusal; its message is safe to return to the caller. */
export class ChatApiError extends Error {
  override readonly name = 'ChatApiError'
  readonly status: number

  constructor(readonly code: ChatApiErrorCode, message: string, readonly retryable = false) {
    super(message)
    this.status = STATUS[code]
  }

  /** The response body: `{ error: { code, message, retryable } }`. */
  body(): { error: { code: ChatApiErrorCode; message: string; retryable: boolean } } {
    return { error: { code: this.code, message: this.message, retryable: this.retryable } }
  }
}

/** One message to answer, as `/chat` reads it or the Studio's test window sends it. */
export interface ChatRequest {
  agentId: string
  /** Who the request speaks for: `/chat` names an end user (`user_id`); the Studio names its signed-in account as an operator. */
  owner: LyteboatRequestOwner
  message: string
  sessionId: string | undefined
  messageId: string | undefined
  traceId: string | undefined
  stream: boolean
  context: { [key: string]: JsonValue } | undefined
  /** History entries from an earlier conversation, as the caller sent them; always with a trace id. */
  history: JsonValue[] | undefined
}

const chatRequestSchema = z.strictObject({
  agent_id: z.string().min(1),
  user_id: z.string().min(1),
  message: z.string().refine((text: string) => text.trim() !== '', 'message must not be blank'),
  session_id: z.string().min(1).optional(),
  message_id: z.string().min(1).optional(),
  trace_id: z.string().min(1).optional(),
  stream: z.boolean().optional(),
  protocol: z.literal('enterprise').optional(),
  context: z.record(z.string(), z.json()).optional(),
  history: z.array(z.json()).optional(),
}).refine(body => body.history === undefined || body.trace_id !== undefined, {
  // The session knows the rounds it answered itself by their requests' trace ids.
  message: 'required with history',
  path: ['trace_id'],
})

/**
 * Read and check a request body.
 * @param text - the body as UTF-8 text.
 * @throws ChatApiError `invalid_request` naming the first problem.
 */
export function parseChatRequest(text: string): ChatRequest {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new ChatApiError('invalid_request', 'the body is not JSON')
  }
  const parsed = chatRequestSchema.safeParse(raw)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const at = issue === undefined || issue.path.length === 0 ? '' : `${issue.path.join('.')}: `
    throw new ChatApiError('invalid_request', `${at}${issue?.message ?? 'invalid body'}`)
  }
  const body = parsed.data
  return {
    agentId: body.agent_id,
    owner: { kind: 'user', id: body.user_id },
    message: body.message,
    sessionId: body.session_id,
    messageId: body.message_id,
    traceId: body.trace_id,
    stream: body.stream ?? false,
    // zod's JSON type is JSON: the casts only name it.
    context: body.context as { [key: string]: JsonValue } | undefined,
    history: body.history as JsonValue[] | undefined,
  }
}

/**
 * Read a request body as UTF-8 text, refusing one larger than `maxBytes`.
 * @throws ChatApiError `body_too_large`, or `invalid_request` for an aborted or non-UTF-8 body.
 */
export async function readChatBody(request: IncomingMessage, maxBytes: number): Promise<string> {
  const declared = Number(request.headers['content-length'] ?? Number.NaN)
  if (Number.isFinite(declared) && declared > maxBytes) {
    request.resume()
    throw new ChatApiError('body_too_large', `the body is larger than ${String(maxBytes)} bytes`)
  }
  const chunks: Buffer[] = []
  let size = 0
  try {
    for await (const chunk of request as AsyncIterable<Buffer | string>) {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      size += bytes.byteLength
      if (size > maxBytes) {
        request.resume()
        throw new ChatApiError('body_too_large', `the body is larger than ${String(maxBytes)} bytes`)
      }
      chunks.push(bytes)
    }
  } catch (error: unknown) {
    if (error instanceof ChatApiError) throw error
    throw new ChatApiError('invalid_request', 'the body was aborted')
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size))
  } catch {
    throw new ChatApiError('invalid_request', 'the body is not UTF-8')
  }
}
