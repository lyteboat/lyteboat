/**
 * The enterprise stream of one `/chat` turn: AGUI envelopes, numbered from 1,
 * with at most one reasoning pair, at most one text-message pair, and exactly
 * one terminal frame (`run_finished` or `run_error`). A frame decorator an
 * agent registers may add fields to a frame's `data`; changing a field the
 * protocol owns fails the frame.
 * @module @lyteboat/chat-api/enterprise-frames
 */

import type { JsonValue, LyteboatTurnOutcomeKind } from '@lyteboat/contracts'

/** The events of an enterprise stream. */
export type ChatEnterpriseEvent =
  | 'run_started'
  | 'reasoning_start'
  | 'reasoning_message_content'
  | 'reasoning_end'
  | 'text_message_start'
  | 'text_message_content'
  | 'text_message_end'
  | 'run_finished'
  | 'run_error'

/** How a frame's `ui_data` is to be read. */
export type ChatUiProtocol = 'text' | 'json' | 'A2UI'

/** A frame's `data`: the fields the protocol owns, and whatever a decorator adds. */
export interface ChatEnterpriseFrameData {
  code: string
  conversation_id: string
  message_id: string
  timestamp: string
  ui_protocol: ChatUiProtocol
  ui_data: JsonValue
  turn: number
  agent_name: string
  extra?: { [key: string]: JsonValue }
  [key: string]: JsonValue | undefined
}

/** One enterprise frame. */
export interface ChatEnterpriseFrame {
  protocol: 'AGUI'
  id: number
  event: ChatEnterpriseEvent
  data: ChatEnterpriseFrameData
}

/** What a frame decorator knows about the request its frame answers. */
export interface ChatFrameContext {
  agentId: string
  sessionId: string
  messageId: string
  userId: string
}

/** Adds fields to a frame's `data`; returns the frame to send. */
export type ChatFrameDecorator = (frame: ChatEnterpriseFrame, context: ChatFrameContext) => ChatEnterpriseFrame

/** The `data` fields the protocol owns; a decorator may not change them. */
const RESERVED_DATA_FIELDS: readonly string[] = ['code', 'conversation_id', 'message_id', 'timestamp', 'ui_protocol', 'ui_data', 'turn', 'agent_name', 'extra']

/**
 * Run one frame through the decorators in order.
 * @throws when a decorator changed the envelope or a field the protocol owns.
 */
function decorateFrame(frame: ChatEnterpriseFrame, context: ChatFrameContext, decorators: readonly ChatFrameDecorator[]): ChatEnterpriseFrame {
  let current = frame
  for (const decorate of decorators) {
    const next = decorate(structuredClone(current), context)
    const changed = ['protocol', 'id', 'event'].filter(key => JSON.stringify(next[key as keyof ChatEnterpriseFrame]) !== JSON.stringify(current[key as keyof ChatEnterpriseFrame]))
    changed.push(...RESERVED_DATA_FIELDS.filter(key => JSON.stringify(next.data[key]) !== JSON.stringify(current.data[key])).map(key => `data.${key}`))
    if (changed.length > 0) throw new Error(`chat-api: a frame decorator changed ${changed.join(', ')}, which the protocol owns`)
    current = next
  }
  return current
}

/** Where the frames of one turn go, and what every frame carries. */
interface ChatFrameStream {
  context: ChatFrameContext
  decorators: readonly ChatFrameDecorator[]
  send(frame: ChatEnterpriseFrame): void
  /** The frame's timestamp; the clock is the caller's. */
  now(): Date
}

/** Writes one turn's frames in protocol order; nothing follows the terminal frame. */
export class ChatEnterpriseWriter {
  private id = 0
  private turn = 0
  private reasoningOpen = false
  private reasoningDone = false
  private textOpen = false
  private textDone = false
  private finished = false
  private answer = ''

  constructor(private readonly stream: ChatFrameStream) {}

  /** The turn that answers the request started. */
  runStarted(turn: number): void {
    this.turn = turn
    this.frame('run_started', 'text', '')
  }

  /**
   * A reasoning delta, or a tool the model called.
   * @param think - what is reasoning: `thinking`, or the tool's name.
   * @param content - the delta, or the tool's arguments.
   */
  reasoning(think: string, content: JsonValue): void {
    if (this.finished || this.reasoningDone) return
    if (!this.reasoningOpen) {
      this.reasoningOpen = true
      this.frame('reasoning_start', 'json', { think, content: [] })
    }
    this.frame('reasoning_message_content', 'json', { think, content: [content] })
  }

  /** Answer text, markers already placed. */
  text(delta: string): void {
    if (this.finished) return
    this.openText()
    this.answer += delta
    this.frame('text_message_content', 'text', delta)
  }

  /** A card, where the answer shows it. */
  card(payload: JsonValue): void {
    if (this.finished) return
    this.openText()
    this.frame('text_message_content', 'A2UI', payload)
  }

  /** The turn ended: close what is open, then `run_finished`. */
  finish(outcome: LyteboatTurnOutcomeKind): void {
    if (this.finished) return
    this.closeText()
    this.closeReasoning()
    this.finished = true
    this.frame('run_finished', 'text', this.answer, { run_outcome: outcome })
  }

  /** The stream failed: close what is open, then `run_error`. */
  fail(message: string, retryable: boolean): void {
    if (this.finished) return
    this.closeText()
    this.closeReasoning()
    this.finished = true
    this.frame('run_error', 'text', message, { retryable })
  }

  /** Whether the terminal frame was written. */
  get done(): boolean {
    return this.finished
  }

  private openText(): void {
    if (this.textOpen || this.textDone) return
    this.textOpen = true
    this.frame('text_message_start', 'text', '')
  }

  private closeText(): void {
    if (!this.textOpen) return
    this.textOpen = false
    this.textDone = true
    this.frame('text_message_end', 'text', this.answer)
  }

  private closeReasoning(): void {
    if (!this.reasoningOpen) return
    this.reasoningOpen = false
    this.reasoningDone = true
    this.frame('reasoning_end', 'json', { think: '', content: [] })
  }

  private frame(event: ChatEnterpriseEvent, protocol: ChatUiProtocol, ui: JsonValue, extra?: { [key: string]: JsonValue }): void {
    const { context } = this.stream
    const frame: ChatEnterpriseFrame = {
      protocol: 'AGUI',
      id: ++this.id,
      event,
      data: {
        code: '200',
        conversation_id: context.sessionId,
        message_id: context.messageId,
        timestamp: this.stream.now().toISOString(),
        ui_protocol: protocol,
        ui_data: ui,
        turn: this.turn,
        agent_name: context.agentId,
        ...extra === undefined ? {} : { extra },
      },
    }
    this.stream.send(decorateFrame(frame, context, this.stream.decorators))
  }
}

/** One frame on the wire: `event: <event>` and `data: <envelope>`. */
export function sseFrame(frame: ChatEnterpriseFrame): string {
  return `event: ${frame.event}\ndata: ${JSON.stringify(frame)}\n\n`
}
