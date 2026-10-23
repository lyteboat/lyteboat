/**
 * `GET /chat/history` and `chatApi.history()`: what a caller shows when it
 * reopens a conversation. Only the person's messages and the agent's answers
 * are listed, in log order; an assistant message that calls a tool is a step
 * on the way, not an answer, and context the harness injected (notices,
 * reminders, a routed skill's invocation) is not a person's message. A round
 * the caller imported with `history` is part of the conversation: its
 * question (source `plugin:lyteboat-history-import`) is listed like a
 * person's message, its answer like the agent's. Cards are not replayed.
 * @module @lyteboat/chat-api/chat-history
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { LYTEBOAT_HISTORY_IMPORT_SOURCE } from '@lyteboat/contracts'
import type { LyteboatRequestOwner } from '@lyteboat/contracts'
import { ChatApiError } from './chat-request.ts'

/** One entry of a replayed conversation. */
export interface ChatHistoryEntry {
  role: 'user' | 'assistant'
  text: string
  /** When the message was logged, epoch ms. */
  at: number
}

/** What `chatApi.history()` reads: one session's conversation, asked for by whoever claims to own it. */
export interface ChatHistoryRequest {
  /** The agent the caller expects the session to run. */
  agentId: string
  /** Who asks; only the session's owner gets its entries. */
  owner: LyteboatRequestOwner
  /** The session to read, as `/chat` returned it. */
  sessionId: string
  /** The newest entries kept, an integer from 1 to 200; 40 when absent. */
  limit?: number
}

/** The query `GET /chat/history` reads. */
interface ChatHistoryQuery {
  agentId: string
  userId: string
  sessionId: string
  /** The newest entries kept. */
  limit: number
}

const CHAT_HISTORY_DEFAULT_LIMIT = 40
const CHAT_HISTORY_MAX_LIMIT = 200

function textOf(content: readonly ContentBlock[]): string {
  return content.map(block => block.type === 'text' ? block.text : '').join('').trim()
}

/**
 * Check how many entries a history read keeps.
 * @param limit - the newest entries asked for; absent for the default.
 * @returns the limit to read with, 40 when absent.
 * @throws ChatApiError `invalid_request` unless it is an integer from 1 to 200.
 */
export function checkChatHistoryLimit(limit: number | undefined): number {
  const checked = limit ?? CHAT_HISTORY_DEFAULT_LIMIT
  if (!Number.isInteger(checked) || checked < 1 || checked > CHAT_HISTORY_MAX_LIMIT) {
    throw new ChatApiError('invalid_request', `limit: an integer from 1 to ${String(CHAT_HISTORY_MAX_LIMIT)}`)
  }
  return checked
}

/**
 * Read and check the query string of `GET /chat/history`.
 * @param search - the request URL's query parameters.
 * @throws ChatApiError `invalid_request` naming the first problem.
 */
export function parseChatHistoryQuery(search: URLSearchParams): ChatHistoryQuery {
  const required = (name: string): string => {
    const value = search.get(name) ?? ''
    if (value === '') throw new ChatApiError('invalid_request', `${name}: required`)
    return value
  }
  const limitText = search.get('limit')
  const limit = checkChatHistoryLimit(limitText === null ? undefined : Number(limitText))
  return { agentId: required('agent_id'), userId: required('user_id'), sessionId: required('session_id'), limit }
}

/**
 * The conversation one session's log holds.
 * @param events - the session's events in log order.
 * @param limit - the newest entries kept.
 * @returns the person's messages and the agent's answers, imported rounds included.
 */
export function chatHistoryOf(events: readonly SessionEvent[], limit: number): ChatHistoryEntry[] {
  const entries: ChatHistoryEntry[] = []
  for (const event of events) {
    if (event.surfaceOp !== 'append') continue
    switch (event.type) {
      case 'user/message': {
        const text = textOf(event.data.content)
        const { kind } = event.data.source
        if ((kind === 'user' || kind === LYTEBOAT_HISTORY_IMPORT_SOURCE) && text !== '') entries.push({ role: 'user', text, at: event.time })
        break
      }
      case 'assistant/message': {
        const { content } = event.data.message
        const text = textOf(content)
        if (text !== '' && !content.some(block => block.type === 'tool-call')) entries.push({ role: 'assistant', text, at: event.time })
        break
      }
      default:
        // Every other node (tool calls and results, turn bounds, projections' records) is not part of the conversation.
        break
    }
  }
  return entries.slice(-limit)
}
