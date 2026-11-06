/**
 * The turn that answers one `/chat` message, followed as it happens. The
 * message is queued to the agent through the session controller, so its turn
 * starts when the agent claims it: `ctx.turnOutcome.follow` hears that turn's
 * events from its start, matched by the message's request id. They and the
 * assistant's stream feed an a2ui live turn (text with cards placed) and the
 * model's reasoning and tool calls are reported; the turn's outcome settles
 * the result, its tool calls with the arguments their `tool/call` events
 * carried.
 * @module @lyteboat/chat-api/chat-turn
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { LyteboatLiveTurn, LyteboatTurnPart } from '@lyteboat/a2ui'
import type { JsonValue, LyteboatTurnOutcomeKind } from '@lyteboat/contracts'
import type {} from '@lyteboat/turn-outcome'

/** What the turn reports as it happens. */
interface ChatTurnObserver {
  /** The agent claimed the message; its turn started. */
  started(turn: number): void
  /** Reasoning text, or a tool the model called with its arguments. */
  reasoning(think: string, content: JsonValue): void
  /** Answer text and cards, as the turn shows them. */
  parts(parts: readonly LyteboatTurnPart[]): void
}

/** A tool the model called in the turn. */
export interface ChatToolCall {
  name: string
  arguments: JsonValue
}

/** How the turn ended. */
export interface ChatTurnResult {
  turn: number
  outcome: LyteboatTurnOutcomeKind
  parts: LyteboatTurnPart[]
  toolCalls: ChatToolCall[]
  /** Why an errored turn failed. */
  error: string | undefined
}

/** One followed turn. */
interface ChatTurnWatch {
  /** Settles when the turn ends. */
  readonly result: Promise<ChatTurnResult>
  /** Whether the message's turn has started and not yet ended. */
  readonly running: boolean
  /** Stop following. */
  dispose(): void
}

/** A tool call's arguments as the model wrote them: JSON when they parse, else the raw text. */
function toolArguments(raw: string): JsonValue {
  try {
    // JSON.parse yields JSON: the cast only names it.
    return JSON.parse(raw) as JsonValue
  } catch {
    return raw
  }
}

/**
 * Follow the turn that answers `messageId`. Call it before the message is
 * submitted, so no event of the turn is missed.
 * @param ctx - the chat-api's context, which hears the session's events and the agent's stream, and reads the turn outcome.
 * @param agent - the agent the message was submitted to.
 * @param messageId - the request id the message carries.
 * @param liveTurn - an a2ui live turn to lay the turn out.
 * @param observer - what hears the turn as it happens.
 */
export function watchChatTurn(ctx: Context, agent: Agent, messageId: string, liveTurn: LyteboatLiveTurn, observer: ChatTurnObserver): ChatTurnWatch {
  const session = agent.session
  let turn: number | undefined
  let ended = false
  const attempts = new Map<string, number>()
  // The turn's tool call arguments by call id, as its `tool/call` events carried them.
  const argumentsByCall = new Map<string, string>()
  const waiting = new AbortController()
  let settle: (result: ChatTurnResult) => void = () => {}
  const result = new Promise<ChatTurnResult>((resolve) => { settle = resolve })

  const show = (parts: readonly LyteboatTurnPart[]): void => { if (parts.length > 0) observer.parts(parts) }
  const disposeEvents = ctx.turnOutcome.follow(session, messageId, (event: SessionEvent, ours: number) => {
    if (turn === undefined) {
      turn = ours
      observer.started(turn)
    }
    if (event.type === 'tool/call') argumentsByCall.set(event.data.callId, event.data.arguments)
    if (event.type === 'assistant/message') {
      for (const block of event.data.message.content) {
        if (block.type === 'tool-call') observer.reasoning(block.name, toolArguments(block.arguments))
      }
    }
    show(liveTurn.event(event))
    // The next turn may start before the outcome settles the result; the live turn shows this one only.
    if (event.type === 'turn/end') ended = true
  })

  const disposeStream = ctx.on('agent/assistant-stream', ({ agent: subject, frame }) => {
    if (subject !== agent || turn === undefined || ended) return
    if (frame.type === 'start') {
      if (frame.turn === turn) attempts.set(frame.attemptId, frame.step)
      return
    }
    if (frame.type !== 'chunk') return
    const step = attempts.get(frame.attemptId)
    if (step === undefined) return
    const chunk = frame.chunk
    if (chunk.type === 'text-delta') show(liveTurn.delta(chunk.text, step))
    else if (chunk.type === 'reasoning-delta' && chunk.text !== '') observer.reasoning('thinking', chunk.text)
  })

  const dispose = (): void => {
    disposeEvents()
    disposeStream()
    waiting.abort()
  }

  ctx.turnOutcome.ended(session, messageId, waiting.signal).then((outcome) => {
    dispose()
    settle({
      turn: outcome.turn,
      outcome: outcome.kind ?? 'errored',
      parts: liveTurn.parts(),
      toolCalls: outcome.tools.map(tool => ({ name: tool.name, arguments: toolArguments(argumentsByCall.get(tool.callId) ?? '') })),
      error: outcome.error?.message,
    })
  }, () => {
    // Only dispose aborts the wait, and then nobody reads the result.
  })

  return {
    result,
    get running() { return turn !== undefined && !ended },
    dispose,
  }
}
