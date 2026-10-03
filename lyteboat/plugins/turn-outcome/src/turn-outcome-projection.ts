/**
 * The `lyteboatTurnOutcomes` projection: each turn of a session folded from
 * its `turn/start` to its `turn/end`. The turn's first human message gives its
 * request (the request's own id, else the session controller's `rpcId`; the
 * owner, agent, trace id, and the admission's decision recorded on it): the
 * fold follows the agent's inbox, so the turn takes the request when it claims
 * the message, and a turn that fails before the message is logged (a throwing
 * intake or pre-assemble listener) still answers it; steps,
 * model requests (answers and failed attempts that streamed), and the side
 * calls made while the turn was open are counted; every tool call is paired
 * with its result; the first content is the first answer text streamed, an
 * answer with text, or an immediate card. At `turn/end` the turn gets its
 * outcome kind: by the reason, and a completed turn the admission answered
 * (a recorded `reply` verdict, or an answer from the admission in the loop) is
 * `rejected`, except in imported history, whose answers carry the same
 * provider: a turn in the inherited prefix (a session seed), or one whose
 * human message is an imported round's question (`@lyteboat/history-import`).
 * Only appended surface nodes are folded. An envelope that fails its schema
 * counts as absent here: its owners (request-context, a2ui) refuse it.
 * @module @lyteboat/turn-outcome/turn-outcome-projection
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import {
  LYTEBOAT_ASSISTANT_PROVIDER,
  LYTEBOAT_HISTORY_IMPORT_SOURCE,
  LYTEBOAT_TURN_OUTCOME_KIND_OF_REASON,
  lyteboatRequestSchema,
  lyteboatResultMetaSchema,
  lyteboatTurnOutcomesStateSchema,
  type JsonValue,
  type LyteboatTurnOutcome,
  type LyteboatTurnOutcomesState,
} from '@lyteboat/contracts'

type TurnOutcomeRequest = NonNullable<LyteboatTurnOutcome['request']>
type TurnOutcomeQueued = LyteboatTurnOutcomesState['queued']

/** The request a turn's first human message carries: its own, else the session controller's request id alone. */
function requestOf(source: { kind: string }): TurnOutcomeRequest {
  // A human message's source is data beside `kind: 'user'`: the request when the caller recorded one, the rpcId when it came through the session controller.
  const carried = source as { lyteboatRequest?: unknown; rpcId?: unknown }
  const parsed = lyteboatRequestSchema.safeParse(carried.lyteboatRequest)
  const request = parsed.success ? parsed.data : {}
  const requestId = request.requestId ?? (typeof carried.rpcId === 'string' ? carried.rpcId : undefined)
  return {
    ...requestId === undefined ? {} : { requestId },
    ...request.owner === undefined ? {} : { owner: request.owner },
    ...request.agent === undefined ? {} : { agentId: request.agent.id },
    ...request.traceId === undefined ? {} : { traceId: request.traceId },
    ...request.intake === undefined ? {} : { intake: request.intake.decision },
  }
}

/** The request a queued message carries: a person's message has one, any other message none. */
function queuedRequestOf(message: SessionEvent<'agent/inbox/spliced'>['data']['inserted'][number]): TurnOutcomeRequest | null {
  return message.source.kind === 'user' ? requestOf(message.source) : null
}

function hasImmediateCard(meta: JsonValue | undefined): boolean {
  const carried = typeof meta === 'object' && meta !== null && !Array.isArray(meta) ? meta['lyteboat'] : undefined
  const parsed = lyteboatResultMetaSchema.safeParse(carried ?? {})
  return parsed.success && (parsed.data.cards ?? []).some(card => card.emission === 'immediate')
}

/** When an answer's first visible text arrived: its first non-blank streamed text, else the answer itself when it has text. */
function firstTextTime(event: SessionEvent<'assistant/message'>): number | undefined {
  for (const record of event.data.stream) {
    if (record.type === 'text-chunks' && record.texts.some(text => text.trim() !== '')) return record.time0
  }
  const hasText = event.data.message.content.some(block => block.type === 'text' && block.text.trim() !== '')
  return hasText ? event.time : undefined
}

/** The state with its open turn changed; the same state when no turn is open. */
function withOpenTurn(state: LyteboatTurnOutcomesState, change: (turn: LyteboatTurnOutcome) => LyteboatTurnOutcome): LyteboatTurnOutcomesState {
  const open = state.turns.at(-1)
  if (open === undefined || open.toSeq !== undefined) return state
  const changed = change(open)
  return changed === open ? state : { ...state, turns: [...state.turns.slice(0, -1), changed] }
}

function startTurn(state: LyteboatTurnOutcomesState, event: SessionEvent<'turn/start'>): LyteboatTurnOutcomesState {
  const turn: LyteboatTurnOutcome = {
    turn: event.data.turn, fromSeq: event.seq, startedAt: event.time, imported: event.seq < state.importedBelowSeq,
    answeredByAdmission: false, steps: 0, modelRequests: 0, auxCalls: 0, tools: [],
  }
  return { ...state, turns: [...state.turns, turn] }
}

function endTurn(turn: LyteboatTurnOutcome, event: SessionEvent<'turn/end'>): LyteboatTurnOutcome {
  if (turn.turn !== event.data.turn) return turn
  const { reason } = event.data
  const byReason = LYTEBOAT_TURN_OUTCOME_KIND_OF_REASON[reason.kind] ?? 'errored'
  const rejected = !turn.imported && (turn.request?.intake === 'reply' || turn.answeredByAdmission)
  return {
    ...turn,
    toSeq: event.seq,
    endedAt: event.time,
    kind: byReason === 'completed' && rejected ? 'rejected' : byReason,
    ...reason.kind === 'error' ? { error: { code: reason.error.code, message: reason.error.message } } : {},
  }
}

/**
 * One splice of the agent's inbox. The queue follows it; a claim (a removal the
 * loop makes for a step, where a cancellation is marked `canceled`) gives the
 * open turn the request of the first person's message it took.
 */
function withInboxSplice(state: LyteboatTurnOutcomesState, event: SessionEvent<'agent/inbox/spliced'>): LyteboatTurnOutcomesState {
  const { target, start, removedCount = 0, inserted, outcome } = event.data
  const pending = state.queued[target]
  const spliced = pending.toSpliced(start, removedCount, ...inserted.map(queuedRequestOf))
  const queued: TurnOutcomeQueued = target === 'next-turn'
    ? { 'next-turn': spliced, 'next-step': state.queued['next-step'] }
    : { 'next-turn': state.queued['next-turn'], 'next-step': spliced }
  const next = { ...state, queued }
  const claimed = outcome === 'canceled' ? undefined : pending.slice(start, start + removedCount).find(request => request !== null)
  return claimed === undefined || claimed === null ? next : withOpenTurn(next, turn => turn.request === undefined ? { ...turn, request: claimed } : turn)
}

function withHumanMessage(turn: LyteboatTurnOutcome, event: SessionEvent<'user/message'>): LyteboatTurnOutcome {
  const { source } = event.data
  if (source.kind === LYTEBOAT_HISTORY_IMPORT_SOURCE) return turn.imported ? turn : { ...turn, imported: true }
  if (source.kind !== 'user') return turn
  const request = requestOf(source)
  // The claim gave the turn this message's request; the logged message adds the admission's decision to it.
  if (turn.request !== undefined && turn.request.requestId !== request.requestId) return turn
  return { ...turn, request }
}

function withAnswer(turn: LyteboatTurnOutcome, event: SessionEvent<'assistant/message'>): LyteboatTurnOutcome {
  const streamed = event.data.stream.length > 0 ? 1 : 0
  const byAdmission = !turn.imported && event.data.message.source.provider === LYTEBOAT_ASSISTANT_PROVIDER
  const firstContentAt = turn.firstContentAt ?? firstTextTime(event)
  return {
    ...turn,
    modelRequests: turn.modelRequests + streamed,
    answeredByAdmission: turn.answeredByAdmission || byAdmission,
    ...firstContentAt === undefined ? {} : { firstContentAt },
  }
}

function withToolResult(turn: LyteboatTurnOutcome, event: SessionEvent<'tool/result'>): LyteboatTurnOutcome {
  const { message, error, meta } = event.data
  const firstContentAt = turn.firstContentAt ?? (hasImmediateCard(meta) ? event.time : undefined)
  const tools = turn.tools.map(tool => tool.callId !== message.toolCallId ? tool : {
    ...tool,
    durationMs: Math.max(0, event.time - tool.calledAt),
    isError: message.isError === true,
    ...error === undefined ? {} : { errorCode: error.code },
  })
  return { ...turn, tools, ...firstContentAt === undefined ? {} : { firstContentAt } }
}

/**
 * One event folded into the turns.
 * @param state - the turns before the event.
 * @param event - the next committed event.
 * @returns the turns after it; the same state for an event that changes none.
 */
function applyTurnOutcomeEvent(state: LyteboatTurnOutcomesState, event: SessionEvent): LyteboatTurnOutcomesState {
  switch (event.type) {
    case 'turn/start': return startTurn(state, event)
    case 'agent/inbox/spliced': return withInboxSplice(state, event)
    case 'turn/end': return withOpenTurn(state, turn => endTurn(turn, event))
    case 'step/start': return withOpenTurn(state, turn => ({ ...turn, steps: turn.steps + 1 }))
    case 'assistant/attempt':
      return event.data.stream.length === 0 ? state : withOpenTurn(state, turn => ({ ...turn, modelRequests: turn.modelRequests + 1 }))
    case 'lyteboat/aux-llm-call': return withOpenTurn(state, turn => ({ ...turn, auxCalls: turn.auxCalls + 1 }))
    case 'tool/call':
      return withOpenTurn(state, turn => ({ ...turn, tools: [...turn.tools, { callId: event.data.callId, name: event.data.name, calledAt: event.time, isError: false }] }))
    // A surface replacement (compaction, pruning) repeats what was folded when it was appended.
    case 'user/message': return event.surfaceOp === 'append' ? withOpenTurn(state, turn => withHumanMessage(turn, event)) : state
    case 'assistant/message': return event.surfaceOp === 'append' ? withOpenTurn(state, turn => withAnswer(turn, event)) : state
    case 'tool/result': return event.surfaceOp === 'append' ? withOpenTurn(state, turn => withToolResult(turn, event)) : state
    default: return state
  }
}

/** The state of a log with no events yet, of which the first `inheritedEventCount` are inherited. */
function initialTurnOutcomes(inheritedEventCount: number): LyteboatTurnOutcomesState {
  return { importedBelowSeq: inheritedEventCount, queued: { 'next-turn': [], 'next-step': [] }, turns: [] }
}

/**
 * The turns of a stored log, folded as the projection folds a live one.
 * @param inheritedEventCount - how many leading events are inherited (imported history).
 * @param events - the log from seq 0.
 */
export function foldTurnOutcomes(inheritedEventCount: number, events: readonly SessionEvent[]): LyteboatTurnOutcome[] {
  let state = initialTurnOutcomes(inheritedEventCount)
  for (const event of events) state = applyTurnOutcomeEvent(state, event)
  return state.turns
}

export const lyteboatTurnOutcomesProjectionDefinition = {
  key: 'lyteboatTurnOutcomes',
  stateSchema: lyteboatTurnOutcomesStateSchema,
  init: (_header, inheritedEventCount): LyteboatTurnOutcomesState => initialTurnOutcomes(inheritedEventCount),
  apply: applyTurnOutcomeEvent,
  stateVersion: 2,
} satisfies ProjectionDefinition<'lyteboatTurnOutcomes', LyteboatTurnOutcomesState>
