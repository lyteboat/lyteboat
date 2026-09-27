/**
 * One session's detail, laid out as the original Studio's: the header (the
 * first question, the session id to copy, the owner, the message and turn
 * counts, the latest request's trace id with its link, whether a tracing UI is
 * configured, when it was created and last updated, and its badges), with the
 * Raw toggle and expand-all beside it, over the timeline or, toggled, the Raw
 * view. Mounted per session, so its toggles start fresh.
 * @module @lyteboat/studio-web/client/studio-session-detail
 */

import { useCallback, useMemo, useState } from 'react'
import type { StudioSessionSummary, StudioTimelineItem } from '@lyteboat/contracts/studio'
import { studioApi } from './studio-api-client.ts'
import { useStudioCall } from './studio-call-state.ts'
import { copyStudioText } from './studio-code-body.tsx'
import { CopyIcon, ExpandIcon } from './studio-icons.tsx'
import { formatStudioSessionTime, studioSessionOwnerLabel } from './studio-session-format.ts'
import { studioTraceLink } from './studio-session-item-detail.tsx'
import { StudioSessionBadges } from './studio-session-list.tsx'
import { StudioSessionRawView } from './studio-session-raw.tsx'
import { StudioSessionTimeline, studioTimelineItemOpens } from './studio-session-timeline.tsx'
import { toggledStudioSet } from './studio-toggled-set.ts'

/** dsh names a session `session-<uuid>`: the short form is the uuid's first 8 characters, as the original Studio showed its ids. */
function studioShortSessionId(sessionId: string): string {
  return sessionId.replace(/^session-/u, '').slice(0, 8)
}

function copyStudioSessionValue(value: string): void {
  copyStudioText(value).catch(() => {
    // The browser refused the copy (a permission prompt dismissed); the value stays on screen to select by hand.
  })
}

function formatStudioTraceIdSnippet(traceId: string): string {
  return traceId.length <= 16 ? traceId : `${traceId.slice(0, 8)}…${traceId.slice(-4)}`
}

/** The trace id of the session's latest request that had one. */
function studioLatestTraceId(items: readonly StudioTimelineItem[]): string | undefined {
  for (const item of [...items].reverse()) {
    if (item.kind === 'user' && item.request?.traceId !== undefined) return item.request.traceId
  }
  return undefined
}

function StudioSessionTraceMeta({ traceId, traceTemplate }: { traceId: string | undefined; traceTemplate: string | undefined }) {
  const link = studioTraceLink(traceTemplate, traceId)
  return (
    <>
      {traceId === undefined
        ? <span className="session-meta-item" title="No request trace id in this session's messages">trace —</span>
        : (
          <button className="session-meta-id session-meta-trace-id" onClick={() => copyStudioSessionValue(traceId)} title={`Copy request trace id: ${traceId}`} type="button">
            trace {formatStudioTraceIdSnippet(traceId)}
            <CopyIcon />
          </button>
        )}
      {link.url !== null && <a aria-label="Open the latest request's trace" className="session-meta-trace-link" href={link.url} rel="noreferrer" target="_blank" title="Open the latest request's trace in the configured tracing UI">↗</a>}
      <span className={`session-meta-trace ${traceTemplate === undefined ? 'off' : 'on'}`} title={traceTemplate === undefined ? 'No trace link configured (the Studio API\'s traceLinkTemplate) — no deep links to a tracing UI' : 'Trace link configured — deep links available'}>
        trace ui: {traceTemplate === undefined ? 'off' : 'on'}
      </span>
    </>
  )
}

function StudioSessionHeader({ summary, traceId, traceTemplate, rawOpen, onRaw, onExpandAll }: {
  summary: StudioSessionSummary
  traceId: string | undefined
  traceTemplate: string | undefined
  rawOpen: boolean
  onRaw(): void
  onExpandAll(): void
}) {
  const title = summary.firstMessage ?? summary.sessionId
  return (
    <div className="session-detail-header">
      <div className="session-title-row">
        <div className="session-title-block">
          <div className="session-title" title={title}>{title}</div>
          <div className="session-meta-row">
            <button className="session-meta-id" onClick={() => copyStudioSessionValue(summary.sessionId)} title={`Copy session id: ${summary.sessionId}`} type="button">
              #{studioShortSessionId(summary.sessionId)}
              <CopyIcon />
            </button>
            <span className="session-meta-item" title="会话的主人：第一条请求所属">{studioSessionOwnerLabel(summary.owner)}</span>
            <span className="session-meta-item">{summary.messageCount} msg · {summary.turnCount} turns</span>
            <StudioSessionTraceMeta traceId={traceId} traceTemplate={traceTemplate} />
          </div>
        </div>
        <div className="session-actions">
          <button aria-pressed={rawOpen} className={`chip ${rawOpen ? 'chip-active' : ''}`} onClick={onRaw} title="View the stored log as JSONL" type="button">Raw</button>
          <button aria-label="Expand all" className="icon-action-button" disabled={rawOpen} onClick={onExpandAll} title="Expand all / Collapse all" type="button">
            <ExpandIcon />
          </button>
        </div>
      </div>
      <div className="session-meta-row">
        <span className="session-meta-item">created {formatStudioSessionTime(summary.createdAt)}</span>
        <span className="session-meta-item">updated {formatStudioSessionTime(summary.updatedAt)}</span>
        <StudioSessionBadges session={summary} />
      </div>
    </div>
  )
}

/** The detail of the session `sessionId`. */
export function StudioSessionPane({ agentId, sessionId, traceTemplate }: { agentId: string; sessionId: string; traceTemplate: string | undefined }) {
  const detail = useStudioCall(useCallback(() => studioApi.sessionDetail(agentId, sessionId), [agentId, sessionId]))
  const [rawOpen, setRawOpen] = useState(false)
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set())
  const items = detail.answer?.items
  const openable = useMemo(() => (items ?? []).filter(studioTimelineItemOpens).map(item => item.seq), [items])
  const traceId = useMemo(() => studioLatestTraceId(items ?? []), [items])

  if (detail.error !== null) return <div className="empty-surface">{detail.error}</div>
  if (detail.answer === null) return <div className="empty-surface">Loading session detail...</div>
  const toggle = (seq: number): void => { setExpanded(current => toggledStudioSet(current, seq)) }
  const expandAll = (): void => {
    const allOpen = openable.length > 0 && openable.every(seq => expanded.has(seq))
    setExpanded(allOpen ? new Set() : new Set(openable))
  }

  return (
    <div className="editor-sheet">
      <StudioSessionHeader onExpandAll={expandAll} onRaw={() => setRawOpen(current => !current)} rawOpen={rawOpen} summary={detail.answer.summary} traceId={traceId} traceTemplate={traceTemplate} />
      <div className="session-detail-body">
        {rawOpen
          ? <StudioSessionRawView agentId={agentId} sessionId={sessionId} />
          : (
            <div className="timeline-column">
              <StudioSessionTimeline expanded={expanded} items={detail.answer.items} onToggle={toggle} traceTemplate={traceTemplate} />
            </div>
          )}
      </div>
    </div>
  )
}
