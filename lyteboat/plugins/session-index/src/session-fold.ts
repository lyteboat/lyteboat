/**
 * One stored session folded, in log order, into what the Studio shows of it:
 * its summary (owner, times, counts, whether its last turn is open) and its
 * timeline. Human messages carry their request (`source.lyteboatRequest`);
 * a skill-invocation message is a skill activation; a model answer carries its
 * timing from the step's start; a tool call is paired with its result by call
 * id, which brings the areas of the cards it rendered and its state delta
 * (`tool/result.meta.lyteboat`, read from the appended result only); a side
 * model call is its `lyteboat/aux-llm-call` record, placed after the turn's
 * human message when it came first (the router and the intake classifier
 * decide on the queued message before the step records it). A surface replacement
 * (compaction, pruning) is shown once: a pruned tool result marks its call,
 * any other replacement is a compaction entry. Events before the inherited
 * cut are imported history: shown, marked, and left out of every count.
 * @module @lyteboat/session-index/session-fold
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-skill'
import {
  LYTEBOAT_ASSISTANT_PROVIDER,
  LYTEBOAT_HISTORY_IMPORT_SOURCE,
  LYTEBOAT_TURN_OUTCOME_OF_REASON,
  lyteboatRequestSchema,
  lyteboatResultMetaSchema,
  type JsonValue,
  type LyteboatRequest,
  type LyteboatRequestOwner,
} from '@lyteboat/contracts'
import type { StudioSessionSummary, StudioTimelineItem } from '@lyteboat/contracts/studio'

/** A model answer or a tool call this long or longer counts as slow (the original Studio's threshold). */
export const SESSION_SLOW_CALL_MS = 10_000

const SESSION_SNIPPET_CHARS = 80

type SessionToolItem = Extract<StudioTimelineItem, { kind: 'tool' }>

/** What a search looks into besides the session id. */
export interface SessionSearchFacts {
  /** The human messages' text, in log order. */
  questions: string[]
  traceIds: string[]
  /** The agents the requests went to, as their callers named them. */
  agentIds: string[]
}

/** A folded session. */
interface FoldedSession {
  summary: StudioSessionSummary
  items: StudioTimelineItem[]
  search: SessionSearchFacts
}

function textOf(content: readonly ContentBlock[], type: 'text' | 'reasoning'): string {
  return content.map(block => block.type === type ? block.text : '').join('')
}

function snippetOf(text: string): string {
  return text.length <= SESSION_SNIPPET_CHARS ? text : `${text.slice(0, SESSION_SNIPPET_CHARS)}…`
}

/** A human message's request, when it carries one that parses; a malformed one is shown as none. */
function requestOf(source: { kind: string }): LyteboatRequest | undefined {
  // The stored log is a file: `lyteboatRequest` rides the source only when the caller recorded a request.
  const carried = (source as { lyteboatRequest?: unknown }).lyteboatRequest
  if (carried === undefined) return undefined
  const parsed = lyteboatRequestSchema.safeParse(carried)
  return parsed.success ? parsed.data : undefined
}

function argumentsOf(text: string): JsonValue {
  try {
    return JSON.parse(text) as JsonValue
  } catch {
    // The model wrote arguments that are not JSON; the tool refused them, and the timeline shows them as written.
    return text
  }
}

/** The `lyteboat` part of a tool result's presentation meta, when it parses. */
function resultMetaOf(meta: JsonValue | undefined): { cards: string[]; stateDelta?: { [path: string]: JsonValue } } {
  const carried = typeof meta === 'object' && meta !== null && !Array.isArray(meta) ? meta['lyteboat'] : undefined
  const parsed = lyteboatResultMetaSchema.safeParse(carried ?? {})
  if (!parsed.success) return { cards: [] }
  return {
    cards: (parsed.data.cards ?? []).map(card => card.area),
    ...parsed.data.stateDelta === undefined ? {} : { stateDelta: parsed.data.stateDelta },
  }
}

/** The fold's state; one per session read. */
class SessionFold {
  readonly items: StudioTimelineItem[] = []
  readonly search: SessionSearchFacts = { questions: [], traceIds: [], agentIds: [] }
  private turn = 0
  private turns = 0
  private readonly openTurns = new Set<number>()
  private readonly answeredByAdmission = new Set<number>()
  private readonly stepStarts = new Map<string, number>()
  private readonly calls = new Map<string, { item: SessionToolItem; time: number }>()
  /** Side calls of this turn made before its human message was recorded. */
  private readonly heldAux: StudioTimelineItem[] = []
  private turnHasMessage = false
  private readonly counts = { messages: 0, errors: 0, rejected: 0, aborted: 0, slow: 0 }
  private owner: LyteboatRequestOwner | undefined
  private firstMessage: string | undefined
  private lastUserMessage: string | undefined
  private updatedAt: number

  constructor(private readonly header: SessionHeader, private readonly inherited: number) {
    this.updatedAt = header.createdAt
  }

  add(event: SessionEvent): void {
    this.updatedAt = Math.max(this.updatedAt, event.time)
    const imported = event.seq < this.inherited
    switch (event.type) {
      case 'turn/start':
        this.releaseAux()
        this.turn = event.data.turn
        this.turns++
        this.turnHasMessage = false
        this.openTurns.add(event.data.turn)
        return
      case 'turn/end': return this.turnEnd(event, imported)
      case 'step/start':
        this.stepStarts.set(`${String(event.data.turn)}:${String(event.data.step)}`, event.time)
        return
      case 'user/message': return this.userMessage(event, imported)
      case 'assistant/message': return this.assistantMessage(event, imported)
      case 'tool/call': return this.toolCall(event)
      case 'tool/result': return this.toolResult(event, imported)
      case 'lyteboat/aux-llm-call':
        (this.turnHasMessage ? this.items : this.heldAux).push({
          kind: 'aux', seq: event.seq, turn: this.turn, time: event.time, purpose: event.data.purpose, durationMs: event.data.durationMs,
          ...event.data.failure === undefined ? {} : { failure: event.data.failure.reason },
        })
        return
      default:
        // Log-only records (request headers, attempts, developer and system messages) are not on the timeline.
        return
    }
  }

  folded(): FoldedSession {
    this.releaseAux()
    const summary: StudioSessionSummary = {
      sessionId: this.header.id,
      ...this.owner === undefined ? {} : { owner: this.owner },
      createdAt: this.header.createdAt,
      updatedAt: this.updatedAt,
      messageCount: this.counts.messages,
      turnCount: this.turns,
      ...this.firstMessage === undefined ? {} : { firstMessage: this.firstMessage },
      ...this.lastUserMessage === undefined ? {} : { lastUserMessage: this.lastUserMessage },
      errorCount: this.counts.errors,
      rejectedCount: this.counts.rejected,
      abortedCount: this.counts.aborted,
      slowCount: this.counts.slow,
      openTurn: this.openTurns.size > 0,
      seeded: this.header.isSeeded,
    }
    return { summary, items: this.items, search: this.search }
  }

  /** Put the held side calls on the timeline: after the human message, or where the turn went on without one. */
  private releaseAux(): void {
    this.items.push(...this.heldAux.splice(0))
  }

  /** Every entry but a human message and a side call: a side call held so far precedes it. */
  private emit(item: StudioTimelineItem): void {
    this.releaseAux()
    this.items.push(item)
  }

  private replaced(event: SessionEvent<'user/message' | 'assistant/message'>): void {
    if (event.surfaceOp === 'append') return
    this.emit({ kind: 'compaction', seq: event.seq, turn: this.turn, time: event.time, replaced: event.surfaceOp.endSeq - event.surfaceOp.startSeq + 1 })
  }

  private turnEnd(event: SessionEvent<'turn/end'>, imported: boolean): void {
    const { turn, reason } = event.data
    this.openTurns.delete(turn)
    const outcome = LYTEBOAT_TURN_OUTCOME_OF_REASON[reason.kind] ?? 'errored'
    const counted = outcome === 'completed' && this.answeredByAdmission.has(turn) ? 'rejected' : outcome
    this.emit({ kind: 'turn-end', seq: event.seq, turn, time: event.time, outcome: counted })
    if (imported) return
    if (counted === 'rejected') this.counts.rejected++
    else if (counted === 'aborted') this.counts.aborted++
    else if (counted === 'errored') this.counts.errors++
  }

  private userMessage(event: SessionEvent<'user/message'>, imported: boolean): void {
    if (event.surfaceOp !== 'append') return this.replaced(event)
    const { source, content } = event.data
    if (source.kind === 'skill-invocation') {
      this.emit({ kind: 'skill', seq: event.seq, turn: this.turn, time: event.time, skill: source.name })
      return
    }
    // The stored log is a file: a person's late answer to a question the model asked carries the kind
    // dsh's user-questions declares, which this build's types do not load. Other kinds are context the
    // harness injected (notices, reminders), not a person's message.
    const kind: string = source.kind
    if (kind !== 'user' && kind !== 'user-question-reply' && kind !== LYTEBOAT_HISTORY_IMPORT_SOURCE) return
    const text = textOf(content, 'text')
    const request = requestOf(source)
    this.items.push({
      kind: 'user', seq: event.seq, turn: this.turn, time: event.time, text,
      ...request === undefined ? {} : { request },
      imported: imported || source.kind === LYTEBOAT_HISTORY_IMPORT_SOURCE,
    })
    this.turnHasMessage = true
    this.releaseAux()
    this.counts.messages++
    this.firstMessage ??= snippetOf(text)
    this.lastUserMessage = snippetOf(text)
    this.search.questions.push(text)
    if (request?.traceId !== undefined) this.search.traceIds.push(request.traceId)
    if (request?.agent !== undefined) this.search.agentIds.push(request.agent.id)
    this.owner ??= request?.owner
  }

  private assistantMessage(event: SessionEvent<'assistant/message'>, imported: boolean): void {
    if (event.surfaceOp !== 'append') return this.replaced(event)
    const { turn, step, message, usage, stream } = event.data
    const byAdmission = message.source.provider === LYTEBOAT_ASSISTANT_PROVIDER
    if (byAdmission) this.answeredByAdmission.add(turn)
    const stepStart = this.stepStarts.get(`${String(turn)}:${String(step)}`)
    const firstChunk = stream.length === 0 ? undefined : Math.min(...stream.map(record => record.type === 'chunk' ? record.time : record.time0))
    const llmMs = stepStart === undefined || byAdmission ? undefined : event.time - stepStart
    const reasoning = textOf(message.content, 'reasoning')
    this.emit({
      kind: 'assistant', seq: event.seq, turn, time: event.time, text: textOf(message.content, 'text'),
      ...reasoning === '' ? {} : { reasoning },
      ...usage === undefined ? {} : { usage },
      ...byAdmission ? {} : { model: `${message.source.provider}/${message.source.model}` },
      ...llmMs === undefined ? {} : { llmMs },
      ...stepStart === undefined || firstChunk === undefined ? {} : { firstTokenMs: firstChunk - stepStart },
      answeredByAdmission: byAdmission,
      imported,
    })
    this.counts.messages++
    if (!imported && llmMs !== undefined && llmMs >= SESSION_SLOW_CALL_MS) this.counts.slow++
  }

  private toolCall(event: SessionEvent<'tool/call'>): void {
    const { turn, callId, name, arguments: text } = event.data
    const item: SessionToolItem = { kind: 'tool', seq: event.seq, turn, time: event.time, callId, name, arguments: argumentsOf(text), isError: false, cards: [], pruned: false }
    this.emit(item)
    this.calls.set(callId, { item, time: event.time })
  }

  private toolResult(event: SessionEvent<'tool/result'>, imported: boolean): void {
    const { message, meta } = event.data
    const call = this.calls.get(message.toolCallId)
    if (event.surfaceOp !== 'append') {
      // A later, shortened copy of a result: the call keeps the original result and is marked.
      if (call !== undefined) call.item.pruned = true
      else this.emit({ kind: 'compaction', seq: event.seq, turn: this.turn, time: event.time, replaced: event.surfaceOp.endSeq - event.surfaceOp.startSeq + 1 })
      return
    }
    if (call === undefined) return
    const durationMs = event.time - call.time
    const { cards, stateDelta } = resultMetaOf(meta)
    call.item.result = textOf(message.content, 'text')
    call.item.isError = message.isError === true
    call.item.durationMs = durationMs
    call.item.cards = cards
    if (stateDelta !== undefined) call.item.stateDelta = stateDelta
    if (imported) return
    if (call.item.isError) this.counts.errors++
    if (durationMs >= SESSION_SLOW_CALL_MS) this.counts.slow++
  }
}

/**
 * Fold one stored session.
 * @param header - its stored header.
 * @param inheritedEventCount - how many leading events are inherited (imported history).
 * @param events - its events from seq 0.
 */
export function foldSession(header: SessionHeader, inheritedEventCount: number, events: readonly SessionEvent[]): FoldedSession {
  const fold = new SessionFold(header, inheritedEventCount)
  for (const event of events) fold.add(event)
  return fold.folded()
}
