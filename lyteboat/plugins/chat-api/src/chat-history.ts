/**
 * `GET /chat/history`: what a caller shows when it reopens a conversation.
 * Only the person's messages and the agent's answers are listed, in log
 * order; an assistant message that calls a tool is a step on the way, not an
 * answer, and context the harness injected (notices, reminders, a routed
 * skill's invocation) is not a person's message. Cards are not replayed.
 * @module @lyteboat/chat-api/chat-history
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { ChatApiError } from './chat-request.ts'

/** One entry of a replayed conversation. */
export interface ChatHistoryEntry {
  role: 'user' | 'assistant'
  text: string
  /** When the message was logged, epoch ms. */
  at: number
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
  const limit = limitText === null ? CHAT_HISTORY_DEFAULT_LIMIT : Number(limitText)
  if (!Number.isInteger(limit) || limit < 1 || limit > CHAT_HISTORY_MAX_LIMIT) {
    throw new ChatApiError('invalid_request', `limit: an integer from 1 to ${String(CHAT_HISTORY_MAX_LIMIT)}`)
  }
  return { agentId: required('agent_id'), userId: required('user_id'), sessionId: required('session_id'), limit }
}

/**
 * The conversation one session's log holds.
 * @param events - the session's events in log order.
 * @param limit - the newest entries kept.
 * @returns the person's messages and the agent's answers.
 */
export function chatHistoryOf(events: readonly SessionEvent[], limit: number): ChatHistoryEntry[] {
  const entries: ChatHistoryEntry[] = []
  for (const event of events) {
    if (event.surfaceOp !== 'append') continue
    switch (event.type) {
      case 'user/message': {
        const text = textOf(event.data.content)
        if (event.data.source.kind === 'user' && text !== '') entries.push({ role: 'user', text, at: event.time })
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
