/**
 * A session log written by hand, event by event, the way the agent loop and
 * lyteboat's plugins append them: turns and steps (a step opens before the
 * messages entering it and closes before the next step or the turn's end, as
 * dsh's stored-log reader requires), human messages with their request, skill
 * invocations, model answers, tool calls and results with their presentation
 * meta, side model calls, and surface replacements.
 */
import { createAssistantMessage, createToolResultMessage, createUserMessage, ToolCallId, type ContentBlock, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, SessionId, SessionSeq, type SessionEvent, type SessionHeader, type TurnEndReason } from '@deepseek-ai/dsh-session'
import { LYTEBOAT_ASSISTANT_PROVIDER, LYTEBOAT_HISTORY_IMPORT_SOURCE, type JsonValue, type LyteboatAuxLlmCallRecord, type LyteboatRequest } from '@lyteboat/contracts'

const text = (value: string): ContentBlock[] => [{ type: 'text', text: value }]

export class SessionLogBuilder {
  readonly events: SessionEvent[] = []
  private turn = 0
  private step = 0
  private stepOpen = false

  constructor(private time: number) {}

  /** A header for this log. */
  header(id: string, cwd: string, isSeeded = false): SessionHeader {
    return { version: SESSION_FORMAT_VERSION, id: SessionId(id), createdAt: this.events[0]?.time ?? this.time, cwd, isSeeded }
  }

  /** Let `ms` pass before the next event. */
  after(ms: number): this {
    this.time += ms
    return this
  }

  turnStart(): this {
    this.turn++
    this.step = 0
    return this.push({ type: 'turn/start', data: { turn: this.turn } })
  }

  /** Open the next step, closing the one before, as the loop does. */
  stepStart(): this {
    this.stepEnd()
    this.step++
    this.stepOpen = true
    return this.push({ type: 'step/start', data: { turn: this.turn, step: this.step } })
  }

  user(value: string, request?: LyteboatRequest): this {
    const source = request === undefined ? { kind: 'user' as const } : { kind: 'user' as const, lyteboatRequest: request }
    return this.push({ type: 'user/message', data: createUserMessage({ content: text(value), source }), surfaceOp: 'append' })
  }

  /** A person's late answer to a question the model asked, as dsh's user-questions appends it. */
  questionReply(value: string, callId: string): this {
    // dsh's user-questions declares this source kind; the types this package loads do not.
    const source = { kind: 'user-question-reply', callId: ToolCallId(callId), outcome: 'answered' } as unknown as UserMessage['source']
    return this.push({ type: 'user/message', data: createUserMessage({ content: text(value), source }), surfaceOp: 'append' })
  }

  imported(value: string): this {
    return this.push({ type: 'user/message', data: createUserMessage({ content: text(value), source: { kind: LYTEBOAT_HISTORY_IMPORT_SOURCE } }), surfaceOp: 'append' })
  }

  skill(name: string): this {
    return this.push({ type: 'user/message', data: createUserMessage({ content: text(`<skill_content name="${name}">body</skill_content>`), source: { kind: 'skill-invocation', name, form: 'instructions' } }), surfaceOp: 'append' })
  }

  assistant(value: string, options: { byAdmission?: boolean; reasoning?: string } = {}): this {
    const provider = options.byAdmission === true ? LYTEBOAT_ASSISTANT_PROVIDER : 'mock'
    const content: ContentBlock[] = [...options.reasoning === undefined ? [] : [{ type: 'reasoning' as const, text: options.reasoning }], ...text(value)]
    const message = createAssistantMessage({ content, source: { provider, model: 'm1' } })
    const stream = options.byAdmission === true ? [] : [{ type: 'text-chunks' as const, time0: this.time - 1, index: 0, dt: [0], texts: [value] }]
    return this.push({
      type: 'assistant/message',
      data: { turn: this.turn, step: this.step, message, stream, ...options.byAdmission === true ? {} : { usage: { inputTokens: 10, outputTokens: 5 } } },
      surfaceOp: 'append',
    })
  }

  toolCall(callId: string, name: string, args: string): this {
    return this.push({ type: 'tool/call', data: { turn: this.turn, step: this.step, callId: ToolCallId(callId), name, arguments: args } })
  }

  toolResult(callId: string, value: string, options: { isError?: boolean; meta?: JsonValue; replaces?: [number, number] } = {}): this {
    const message = createToolResultMessage({ callId: ToolCallId(callId), content: text(value), isError: options.isError === true })
    const surfaceOp = options.replaces === undefined ? 'append' as const : { op: 'replace' as const, startSeq: SessionSeq(options.replaces[0]), endSeq: SessionSeq(options.replaces[1]) }
    return this.push({ type: 'tool/result', data: { turn: this.turn, step: this.step, message, ...options.meta === undefined ? {} : { meta: options.meta } }, surfaceOp })
  }

  /** A compaction summary replacing the surface nodes `from`..`to`. */
  compaction(from: number, to: number): this {
    const message = createAssistantMessage({ content: text('summary of earlier work'), source: { provider: 'mock', model: 'm1' } })
    return this.push({
      type: 'assistant/message', data: { turn: this.turn, step: this.step, message, stream: [] },
      surfaceOp: { op: 'replace', startSeq: SessionSeq(from), endSeq: SessionSeq(to) },
    })
  }

  aux(record: Partial<LyteboatAuxLlmCallRecord> = {}): this {
    const data: LyteboatAuxLlmCallRecord = { purpose: 'skill-router', route: { provider: 'mock', model: 'm1' }, system: 's', prompt: 'p', maxTokens: 200, temperature: 0, durationMs: 120, ...record }
    return this.push({ type: 'lyteboat/aux-llm-call', data, ignorable: true })
  }

  turnEnd(kind: TurnEndReason['kind'] = 'completed'): this {
    this.stepEnd()
    const reason = kind === 'error'
      ? { kind: 'error', error: { code: 'UNKNOWN', message: 'the model failed' } }
      : kind === 'aborted' ? { kind: 'aborted', reason: { kind: 'legacy' } } : { kind }
    return this.push({ type: 'turn/end', data: { turn: this.turn, reason } })
  }

  private stepEnd(): void {
    if (!this.stepOpen) return
    this.stepOpen = false
    this.push({ type: 'step/end', data: { turn: this.turn, step: this.step } })
  }

  private push(event: Record<string, unknown>): this {
    // Built by hand at the storage boundary, exactly as the loop would append it.
    this.events.push({ ...event, seq: SessionSeq(this.events.length), time: this.time } as unknown as SessionEvent)
    this.time += 1
    return this
  }
}
