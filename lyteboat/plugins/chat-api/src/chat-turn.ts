/**
 * The turn that answers one `/chat` message, followed as it happens. The
 * message is queued to the agent through the session controller, so its turn
 * starts when the agent claims it: the turn whose `user/message` carries the
 * request id as its `rpcId`. From there the session's events and the
 * assistant's stream feed an a2ui live turn (text with cards placed), the
 * model's reasoning and tool calls are reported, and `turn/end` settles the
 * outcome.
 * @module @lyteboat/chat-api/chat-turn
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent, TurnEndReason } from '@deepseek-ai/dsh-session'
import type { LyteboatLiveTurn, LyteboatTurnPart } from '@lyteboat/a2ui'
import { LYTEBOAT_ASSISTANT_PROVIDER, LYTEBOAT_TURN_OUTCOME_OF_REASON } from '@lyteboat/contracts'
import type { JsonValue, LyteboatTurnOutcome } from '@lyteboat/contracts'

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
  outcome: LyteboatTurnOutcome
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

/** The request id a human message's source carries, when the session controller wrote it. */
function rpcIdOf(event: SessionEvent): string | undefined {
  if (event.type !== 'user/message') return undefined
  const source = event.data.source as { kind: string; rpcId?: unknown }
  return typeof source.rpcId === 'string' ? source.rpcId : undefined
}

/**
 * The outcome of a turn from its `turn/end` reason.
 * @param reason - the reason's kind.
 * @param answeredInLoop - whether the answer came from the admission in the loop (an assistant message from `LYTEBOAT_ASSISTANT_PROVIDER`).
 */
function turnOutcome(reason: TurnEndReason['kind'], answeredInLoop: boolean): LyteboatTurnOutcome {
  const outcome = LYTEBOAT_TURN_OUTCOME_OF_REASON[reason] ?? 'errored'
  return outcome === 'completed' && answeredInLoop ? 'rejected' : outcome
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
 * @param ctx - the chat-api's context, which hears the session's events and the agent's stream.
 * @param agent - the agent the message was submitted to.
 * @param messageId - the request id the message carries.
 * @param liveTurn - an a2ui live turn to lay the turn out.
 * @param observer - what hears the turn as it happens.
 */
export function watchChatTurn(ctx: Context, agent: Agent, messageId: string, liveTurn: LyteboatLiveTurn, observer: ChatTurnObserver): ChatTurnWatch {
  let ours = false
  let ended = false
  let turn = 0
  let turnStart: SessionEvent | undefined
  let stepStart: SessionEvent | undefined
  let answeredInLoop = false
  const toolCalls: ChatToolCall[] = []
  const attempts = new Map<string, number>()
  let settle: (result: ChatTurnResult) => void = () => {}
  const result = new Promise<ChatTurnResult>((resolve) => { settle = resolve })

  const show = (parts: readonly LyteboatTurnPart[]): void => { if (parts.length > 0) observer.parts(parts) }

  const disposeEvents = ctx.on('session/event', (session, event) => {
    if (session !== agent.session || ended) return
    if (!ours) {
      if (event.type === 'turn/start') turnStart = event
      else if (event.type === 'step/start') stepStart = event
      else if (rpcIdOf(event) === messageId && turnStart?.type === 'turn/start') {
        ours = true
        turn = turnStart.data.turn
        observer.started(turn)
        if (stepStart !== undefined) liveTurn.event(stepStart)
        show(liveTurn.event(event))
      }
      return
    }
    if (event.type === 'assistant/message') {
      const message = event.data.message
      if (message.source.provider === LYTEBOAT_ASSISTANT_PROVIDER) answeredInLoop = true
      for (const block of message.content) {
        if (block.type !== 'tool-call') continue
        const call = { name: block.name, arguments: toolArguments(block.arguments) }
        toolCalls.push(call)
        observer.reasoning(call.name, call.arguments)
      }
    }
    show(liveTurn.event(event))
    if (event.type === 'turn/end' && event.data.turn === turn) {
      ended = true
      const reason = event.data.reason
      settle({
        turn,
        outcome: turnOutcome(reason.kind, answeredInLoop),
        parts: liveTurn.parts(),
        toolCalls,
        error: reason.kind === 'error' ? reason.error.message : undefined,
      })
      dispose()
    }
  })

  const disposeStream = ctx.on('agent/assistant-stream', ({ agent: subject, frame }) => {
    if (subject !== agent || !ours || ended) return
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
  }

  return {
    result,
    get running() { return ours && !ended },
    dispose,
  }
}
