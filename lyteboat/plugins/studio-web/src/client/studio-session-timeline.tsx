/**
 * A session's timeline, drawn as the original Studio's event line and grouped
 * by turn: each turn opens with its number, then its entries in log order. A
 * row shows the entry's kind (and whether it is imported history, the
 * admission's answer, or a pruned result), its summary and timing, when it was
 * written, and its turn (a tool call: OK or ERR); a human message, a model
 * answer, or a tool call opens to its detail. Skill activations, side model
 * calls, compaction markers, and the turn's end (its outcome) are rows that do
 * not open. What a model wrote (its answers, its side calls) is marked for the
 * AI zone's colours.
 * @module @lyteboat/studio-web/client/studio-session-timeline
 */

import { Fragment, useMemo } from 'react'
import type { LyteboatTurnOutcome } from '@lyteboat/contracts'
import type { StudioTimelineItem } from '@lyteboat/contracts/studio'
import { ChevronRightIcon } from './studio-icons.tsx'
import {
  STUDIO_SESSION_SLOW_MS,
  formatStudioSessionSeconds,
  formatStudioSessionTime,
  formatStudioSessionTurn,
  summarizeStudioSessionText,
} from './studio-session-format.ts'
import { StudioTimelineItemDetail, studioTraceLink, type StudioTraceLink } from './studio-session-item-detail.tsx'

type StudioTimelineKind = StudioTimelineItem['kind']

/** A turn's entries, in log order. */
interface StudioTimelineTurn {
  turn: number
  firstSeq: number
  imported: boolean
  items: StudioTimelineItem[]
}

const STUDIO_TIMELINE_PILL: Record<StudioTimelineKind, string> = {
  user: 'USER',
  assistant: 'ASSISTANT',
  tool: 'TOOL',
  skill: 'SKILL',
  aux: 'AUX',
  compaction: 'COMPACT',
  'turn-end': 'END',
}

const STUDIO_TURN_OUTCOME_NOTE: Record<LyteboatTurnOutcome, string> = {
  completed: '模型已回答',
  rejected: '准入代答，本轮未调用模型',
  tool_stopped: '工具被拦下，本轮停止',
  stopped_by_limit: '输出达到 token 上限，本轮停止',
  aborted: '本轮被取消',
  errored: '本轮出错',
}

/** Whether an entry opens to a detail: a human message, a model answer, or a tool call. */
export function studioTimelineItemOpens(item: StudioTimelineItem): boolean {
  return item.kind === 'user' || item.kind === 'assistant' || item.kind === 'tool'
}

function studioTimelineItemImported(item: StudioTimelineItem): boolean {
  return (item.kind === 'user' || item.kind === 'assistant') && item.imported
}

/** Whether a model wrote the entry (an answer the admission did not give, a side model call): it is drawn on the AI zone's colours. */
function studioTimelineItemByModel(item: StudioTimelineItem): boolean {
  return (item.kind === 'assistant' && !item.answeredByAdmission) || item.kind === 'aux'
}

function studioTimelineTurns(items: readonly StudioTimelineItem[]): StudioTimelineTurn[] {
  const turns: StudioTimelineTurn[] = []
  for (const item of items) {
    const last = turns.at(-1)
    if (last !== undefined && last.turn === item.turn) {
      last.items.push(item)
      last.imported ||= studioTimelineItemImported(item)
    } else {
      turns.push({ turn: item.turn, firstSeq: item.seq, imported: studioTimelineItemImported(item), items: [item] })
    }
  }
  return turns
}

/** The trace id of each turn's request, for the trace links of the turn's messages. */
function studioTurnTraceIds(items: readonly StudioTimelineItem[]): Map<number, string> {
  const traceIds = new Map<number, string>()
  for (const item of items) {
    if (item.kind === 'user' && item.request?.traceId !== undefined) traceIds.set(item.turn, item.request.traceId)
  }
  return traceIds
}

/** The marker's accent: `err` for a failure, `hook` where the admission or a stop cut in. */
function studioTimelineFlag(item: StudioTimelineItem): '' | 'err' | 'hook' {
  switch (item.kind) {
    case 'user': return item.request?.intake?.decision === 'reply' ? 'hook' : ''
    case 'assistant': return item.answeredByAdmission ? 'hook' : ''
    case 'tool': return item.isError ? 'err' : ''
    case 'aux': return item.failure === undefined ? '' : 'err'
    case 'turn-end': return item.outcome === 'errored' ? 'err' : item.outcome === 'completed' ? '' : 'hook'
    case 'skill':
    case 'compaction': return ''
  }
}

function studioTimelineGutter(item: StudioTimelineItem): { text: string; err: boolean } {
  if (item.kind !== 'tool') return { text: formatStudioSessionTurn(item.turn), err: false }
  if (item.result === undefined) return { text: '…', err: false }
  return item.isError ? { text: 'ERR', err: true } : { text: 'OK', err: false }
}

/** A duration; `countsSlow` marks it slow past the threshold, as `slowCount` counts only model answers and tool calls. */
function StudioTimelineDuration({ ms, prefix, title, countsSlow }: { ms: number; prefix: string; title: string; countsSlow: boolean }) {
  return <span className={`tlm-duration ${countsSlow && ms >= STUDIO_SESSION_SLOW_MS ? 'slow' : ''}`} title={title}>{prefix}{formatStudioSessionSeconds(ms)}</span>
}

function StudioTimelinePills({ item }: { item: StudioTimelineItem }) {
  return (
    <span className="tlm-pills">
      <span className={`tlm-pill tlm-pill-${item.kind}`}>{STUDIO_TIMELINE_PILL[item.kind]}</span>
      {studioTimelineItemImported(item) && <span className="tlm-pill tlm-pill-external" title="导入的历史，不是在这个会话里说的">IMPORTED</span>}
      {item.kind === 'user' && item.request?.intake?.decision === 'reply' && (
        <>
          <span className="tlm-pill tlm-pill-hook-stage" title={`admission: ${item.request.intake.by}`}>intake</span>
          <span className="tlm-pill tlm-pill-hook" title="准入代答，本轮未调用模型">REPLY</span>
        </>
      )}
      {item.kind === 'assistant' && item.answeredByAdmission && <span className="tlm-pill tlm-pill-hook" title="准入代答，跳过了本轮模型调用">ADMISSION</span>}
      {item.kind === 'tool' && item.pruned && <span className="tlm-pill tlm-pill-hook-stage" title="后来的上下文替换缩短了模型看到的结果">PRUNED</span>}
    </span>
  )
}

function StudioTimelineSummary({ text, mono = false }: { text: string; mono?: boolean }) {
  return <span className={`tlm-summary ${mono ? 'mono' : ''}`} title={text}>{text}</span>
}

function StudioTimelineMain({ item }: { item: StudioTimelineItem }) {
  switch (item.kind) {
    case 'user':
      return <span className="tlm-main"><StudioTimelineSummary text={summarizeStudioSessionText(item.text) || '（空消息）'} /></span>
    case 'assistant':
      return (
        <span className="tlm-main">
          <StudioTimelineSummary text={summarizeStudioSessionText(item.text) || '（无回复文本）'} />
          {item.llmMs !== undefined && <StudioTimelineDuration countsSlow ms={item.llmMs} prefix="LLM " title="LLM call time" />}
        </span>
      )
    case 'tool':
      return (
        <span className="tlm-main">
          <StudioTimelineSummary mono text={item.name} />
          {item.durationMs === undefined
            ? <span className="tlm-duration" title="No result yet">no result</span>
            : <StudioTimelineDuration countsSlow ms={item.durationMs} prefix="" title="Tool execution time" />}
        </span>
      )
    case 'skill':
      return <span className="tlm-main"><StudioTimelineSummary mono text={item.skill} /></span>
    case 'aux':
      return (
        <span className="tlm-main">
          <StudioTimelineSummary mono text={item.purpose} />
          <StudioTimelineDuration countsSlow={false} ms={item.durationMs} prefix="" title="Side model call time" />
          {item.failure !== undefined && <span className="tlm-duration err" title="The side model call failed">failed: {item.failure}</span>}
        </span>
      )
    case 'compaction':
      return <span className="tlm-main"><StudioTimelineSummary text={`上下文替换：${String(item.replaced)} 条记录换成了新内容`} /></span>
    case 'turn-end':
      return (
        <span className="tlm-main">
          <span className={`session-outcome session-outcome-${item.outcome}`}>{item.outcome}</span>
          <StudioTimelineSummary text={STUDIO_TURN_OUTCOME_NOTE[item.outcome]} />
        </span>
      )
  }
}

function StudioTimelineEntry({ item, open, onToggle, trace }: { item: StudioTimelineItem; open: boolean; onToggle(seq: number): void; trace: StudioTraceLink }) {
  const opens = studioTimelineItemOpens(item)
  const gutter = studioTimelineGutter(item)
  const time = formatStudioSessionTime(item.time)
  const toggle = (): void => onToggle(item.seq)
  return (
    <li className={`tlm-item ${item.kind} ${open ? 'active' : ''} ${opens ? '' : 'tlm-static'} ${studioTimelineItemByModel(item) ? 'tlm-ai' : ''}`}>
      <div
        aria-expanded={opens ? open : undefined}
        className={`tlm-row ${opens ? '' : 'tlm-static'}`}
        onClick={opens ? toggle : undefined}
        onKeyDown={opens ? event => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          toggle()
        } : undefined}
        role={opens ? 'button' : undefined}
        tabIndex={opens ? 0 : undefined}
      >
        <span aria-hidden="true" className={`tlm-marker tlm-marker-${item.kind} ${studioTimelineFlag(item)}`} />
        <StudioTimelinePills item={item} />
        <StudioTimelineMain item={item} />
        <span aria-label={`Session timestamp ${time}`} className="tlm-timestamp" title={`Session timestamp: ${new Date(item.time).toISOString()}`}>{time}</span>
        <span className={`tlm-gutter ${gutter.err ? 'err' : ''}`}>{gutter.text}</span>
        <ChevronRightIcon className={`tlm-chevron ${open ? 'open' : ''}`} />
      </div>
      {opens && open && <div className="tlm-detail"><StudioTimelineItemDetail item={item} trace={trace} /></div>}
    </li>
  )
}

/**
 * The timeline; `expanded` holds the `seq` of each open entry.
 * @param traceTemplate - the configured trace link, if any.
 */
export function StudioSessionTimeline({ items, traceTemplate, expanded, onToggle }: {
  items: StudioTimelineItem[]
  traceTemplate: string | undefined
  expanded: ReadonlySet<number>
  onToggle(seq: number): void
}) {
  const turns = useMemo(() => studioTimelineTurns(items), [items])
  const traceIds = useMemo(() => studioTurnTraceIds(items), [items])
  if (items.length === 0) return <div className="empty-surface">这个会话还没有消息。</div>
  return (
    <ol aria-label="Session timeline" className="timeline-main">
      {turns.map(group => (
        <Fragment key={group.firstSeq}>
          <li className="tlm-turn-head">
            <span>Turn {formatStudioSessionTurn(group.turn)}</span>
            {group.imported && <span className="tlm-turn-head-note">imported history</span>}
          </li>
          {group.items.map(item => (
            <StudioTimelineEntry item={item} key={item.seq} onToggle={onToggle} open={expanded.has(item.seq)} trace={studioTraceLink(traceTemplate, traceIds.get(item.turn))} />
          ))}
        </Fragment>
      ))}
    </ol>
  )
}
