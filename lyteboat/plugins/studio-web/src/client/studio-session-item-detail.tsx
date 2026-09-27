/**
 * What an opened entry of a session's timeline shows, laid out as the original
 * Studio's message details. A human message: the trace link, the request it
 * carried (request id, owner, trace id, the agent it went to, the admission's
 * verdict, the request context), and its text. A model answer: the trace link,
 * whether the admission gave it, the model, its timing and tokens, its
 * reasoning (folded), and its text. A tool call: its name and result kind, its
 * arguments, its result (as a tree when it is JSON), the areas of the cards it
 * rendered, its state delta, and its call id, turn, and duration.
 * @module @lyteboat/studio-web/client/studio-session-item-detail
 */

import { useState, type ReactNode } from 'react'
import type { JsonValue, LyteboatIntakeVerdict, LyteboatRequest } from '@lyteboat/contracts'
import type { StudioTimelineItem } from '@lyteboat/contracts/studio'
import { StudioCopyButton } from './studio-code-body.tsx'
import { StudioJsonTree } from './studio-json-tree.tsx'
import { formatStudioSessionSeconds, formatStudioSessionTurn, studioSessionOwnerLabel } from './studio-session-format.ts'

/** A context this short or shorter stays on one line instead of a tree. */
const STUDIO_INLINE_JSON_MAX_CHARS = 120

type StudioUserItem = Extract<StudioTimelineItem, { kind: 'user' }>
type StudioAssistantItem = Extract<StudioTimelineItem, { kind: 'assistant' }>
type StudioToolItem = Extract<StudioTimelineItem, { kind: 'tool' }>

/** Where a turn's trace opens, or why it does not. */
export interface StudioTraceLink {
  url: string | null
  reason: string
}

/**
 * @param template - the configured link, with `{trace_id}` where the id goes; undefined when none is.
 * @param traceId - the turn's request's trace id, if it had one.
 * @returns the link.
 */
export function studioTraceLink(template: string | undefined, traceId: string | undefined): StudioTraceLink {
  if (template === undefined) return { url: null, reason: 'Tracing UI not configured — set the Studio API\'s traceLinkTemplate' }
  if (traceId === undefined) return { url: null, reason: 'No trace id on this turn\'s request' }
  // The id is the caller's: encoded, it stays inside the slot the template gave it.
  return { url: template.replaceAll('{trace_id}', encodeURIComponent(traceId)), reason: 'Trace available' }
}

function StudioTraceLinkButton({ link }: { link: StudioTraceLink }) {
  if (link.url !== null) {
    return <a className="action-button" href={link.url} rel="noreferrer" target="_blank" title="Open this turn's trace in the configured tracing UI">View in trace ↗</a>
  }
  return <button className="action-button" disabled title={link.reason} type="button">View in trace ↗</button>
}

function StudioDetailRow({ label, mono = false, children }: { label: string; mono?: boolean; children: ReactNode }) {
  return (
    <div className="dt-row">
      <div className="dt-label">{label}</div>
      <div className={`dt-value ${mono ? 'mono' : ''}`}>{children}</div>
    </div>
  )
}

function StudioCopyableRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="dt-row dt-row-message-id">
      <div className="dt-label">{label}</div>
      <div className="dt-value mono dt-message-id-value" title={value}>
        <span className="dt-message-id-cluster">
          <code className="dt-message-id-code">{value}</code>
          <StudioCopyButton title={label} value={value} />
        </span>
      </div>
    </div>
  )
}

function StudioTextBlock({ label, text }: { label: string; text: string }) {
  return (
    <div className="dt-block">
      <div className="dt-label">{label}</div>
      <pre className="code-block compact">{text}</pre>
    </div>
  )
}

function StudioJsonBlock({ label, value }: { label: string; value: JsonValue }) {
  const text = JSON.stringify(value)
  return (
    <div className="dt-block">
      <div className="dt-label">{label}</div>
      {text.length <= STUDIO_INLINE_JSON_MAX_CHARS
        ? <code className="dt-inline-json">{text}</code>
        : <div className="tool-output-tree"><StudioJsonTree value={value} /></div>}
    </div>
  )
}

function StudioIntakeRows({ intake }: { intake: LyteboatIntakeVerdict }) {
  const replied = intake.decision === 'reply'
  return (
    <>
      <StudioDetailRow label="admission">
        <div className="dt-tools-inline">
          <span className="chip">{intake.by}</span>
          <span className={`chip ${replied ? 'chip-hook' : ''}`}>{intake.decision}</span>
          {intake.verdict !== undefined && <span className="chip">{intake.verdict}</span>}
          {intake.cards?.map(card => <span className="chip" key={card.surfaceId}>card:{card.area}</span>)}
          <span className="dt-hint">{replied ? '准入代答，本轮未调用模型' : '准入放行，由模型回答'}</span>
        </div>
      </StudioDetailRow>
      {intake.text !== undefined && <StudioTextBlock label="admission reply" text={intake.text} />}
    </>
  )
}

function StudioRequestRows({ request }: { request: LyteboatRequest }) {
  const { agent } = request
  return (
    <>
      {request.requestId !== undefined && <StudioCopyableRow label="request_id" value={request.requestId} />}
      {request.owner !== undefined && <StudioDetailRow label="owner"><span className="chip">{studioSessionOwnerLabel(request.owner)}</span></StudioDetailRow>}
      {request.traceId !== undefined && <StudioCopyableRow label="trace_id" value={request.traceId} />}
      {agent !== undefined && (
        <StudioDetailRow label="agent">
          <span className="chip" title={agent.digest}>{agent.version === undefined ? agent.id : `${agent.id} v${agent.version}`}</span>
        </StudioDetailRow>
      )}
      {request.intake !== undefined && <StudioIntakeRows intake={request.intake} />}
      {request.context !== undefined && <StudioJsonBlock label="context" value={request.context} />}
    </>
  )
}

function StudioUserItemDetail({ item, trace }: { item: StudioUserItem; trace: StudioTraceLink }) {
  return (
    <>
      <div className="dt-toolbar"><StudioTraceLinkButton link={trace} /></div>
      {item.request === undefined
        ? <div className="dt-empty">No request metadata captured for this message.</div>
        : <StudioRequestRows request={item.request} />}
      <StudioTextBlock label="message" text={item.text} />
    </>
  )
}

function studioAssistantTiming(item: StudioAssistantItem): string | null {
  const parts = [
    ...item.llmMs === undefined ? [] : [`LLM ${formatStudioSessionSeconds(item.llmMs)}`],
    ...item.firstTokenMs === undefined ? [] : [`first token ${formatStudioSessionSeconds(item.firstTokenMs)}`],
  ]
  return parts.length === 0 ? null : parts.join(' · ')
}

function studioAssistantTokens(usage: NonNullable<StudioAssistantItem['usage']>): string {
  const count = (value: number): string => value.toLocaleString()
  return [
    `in ${count(usage.inputTokens)}`,
    `out ${count(usage.outputTokens)}`,
    ...usage.cacheReadTokens === undefined ? [] : [`cache read ${count(usage.cacheReadTokens)}`],
    ...usage.reasoningTokens === undefined ? [] : [`reasoning ${count(usage.reasoningTokens)}`],
    ...usage.totalTokens === undefined ? [] : [`total ${count(usage.totalTokens)}`],
  ].join(' · ')
}

function StudioReasoningBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="dt-block">
      <div className="dt-label-row">
        <span className="dt-label">thinking · {text.length.toLocaleString()} chars</span>
        <button aria-expanded={open} className="dt-mini-toggle" onClick={() => setOpen(current => !current)} type="button">{open ? 'hide' : 'show'}</button>
      </div>
      {open && <pre className="code-block compact">{text}</pre>}
    </div>
  )
}

function StudioAssistantItemDetail({ item, trace }: { item: StudioAssistantItem; trace: StudioTraceLink }) {
  const timing = studioAssistantTiming(item)
  return (
    <>
      <div className="dt-toolbar"><StudioTraceLinkButton link={trace} /></div>
      {item.answeredByAdmission && (
        <StudioDetailRow label="admission">
          <div className="dt-tools-inline">
            <span className="chip chip-hook">reply</span>
            <span className="dt-hint">准入代答，跳过了本轮模型调用</span>
          </div>
        </StudioDetailRow>
      )}
      {item.model !== undefined && <StudioDetailRow label="model" mono>{item.model}</StudioDetailRow>}
      {timing !== null && <StudioDetailRow label="timing" mono>{timing}</StudioDetailRow>}
      {item.usage !== undefined && <StudioDetailRow label="tokens" mono>{studioAssistantTokens(item.usage)}</StudioDetailRow>}
      {item.reasoning !== undefined && <StudioReasoningBlock text={item.reasoning} />}
      <StudioTextBlock label="answer" text={item.text === '' ? '（无回复文本）' : item.text} />
    </>
  )
}

/** The result as a tree when it is a JSON object or array; null when it is plain text. */
function studioParsedResult(result: string): JsonValue | null {
  const trimmed = result.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null
  try {
    return JSON.parse(trimmed) as JsonValue
  } catch {
    // Text that only looks like JSON: it is shown as written.
    return null
  }
}

function StudioToolOutput({ result, isError }: { result: string | undefined; isError: boolean }) {
  const [raw, setRaw] = useState(false)
  if (result === undefined) {
    return (
      <div className="dt-block">
        <div className="dt-label">output</div>
        <div className="dt-empty">No result: the call is still running, or its turn ended without one.</div>
      </div>
    )
  }
  const parsed = studioParsedResult(result)
  return (
    <div className="dt-block">
      <div className="dt-label-row">
        <span className="dt-label">output</span>
        {parsed !== null && <button className="dt-mini-toggle" onClick={() => setRaw(current => !current)} type="button">{raw ? 'tree view' : 'raw view'}</button>}
      </div>
      {parsed !== null && !raw
        ? <div className="tool-output-tree"><StudioJsonTree value={parsed} /></div>
        : <pre className={`code-block compact ${isError ? 'is-error' : ''}`}>{result}</pre>}
    </div>
  )
}

function studioToolResultKind(item: StudioToolItem): string {
  if (item.isError) return 'error'
  return item.result !== undefined && studioParsedResult(item.result) !== null ? 'json' : 'text'
}

function StudioToolItemDetail({ item }: { item: StudioToolItem }) {
  const resultKind = studioToolResultKind(item)
  return (
    <>
      <div className="tool-detail-head">
        <span className="tool-detail-name">{item.name}</span>
        <span className={`chip chip-result chip-result-${resultKind}`}>{resultKind}</span>
        {item.pruned && <span className="chip chip-hook" title="后来的上下文替换缩短了模型看到的结果；这里是原始结果">pruned</span>}
      </div>
      <StudioTextBlock label="arguments" text={typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments, null, 2)} />
      <StudioToolOutput isError={item.isError} result={item.result} />
      {item.cards.length > 0 && (
        <StudioDetailRow label="cards">
          <div className="dt-tools-inline">{item.cards.map((area, index) => <span className="chip" key={`${area}-${String(index)}`}>{area}</span>)}</div>
        </StudioDetailRow>
      )}
      {item.stateDelta !== undefined && <StudioTextBlock label="state delta" text={JSON.stringify(item.stateDelta, null, 2)} />}
      <dl className="tool-meta">
        <div className="tool-meta-item tool-meta-item-tool-call-id">
          <dt>tool_call_id</dt>
          <dd><code>{item.callId === '' ? '—' : item.callId}</code></dd>
        </div>
        <div className="tool-meta-item">
          <dt>turn</dt>
          <dd>{formatStudioSessionTurn(item.turn)}</dd>
        </div>
        <div className="tool-meta-item">
          <dt>duration</dt>
          <dd>{item.durationMs === undefined ? '—' : `${String(item.durationMs)} ms`}</dd>
        </div>
      </dl>
    </>
  )
}

/** The detail of an entry that opens (a human message, a model answer, a tool call); null for any other. */
export function StudioTimelineItemDetail({ item, trace }: { item: StudioTimelineItem; trace: StudioTraceLink }) {
  switch (item.kind) {
    case 'user': return <StudioUserItemDetail item={item} trace={trace} />
    case 'assistant': return <StudioAssistantItemDetail item={item} trace={trace} />
    case 'tool': return <StudioToolItemDetail item={item} />
    case 'skill':
    case 'aux':
    case 'compaction':
    case 'turn-end': return null
  }
}
