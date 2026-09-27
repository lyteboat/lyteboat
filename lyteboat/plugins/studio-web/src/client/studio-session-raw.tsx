/**
 * A session as stored, read-only: its log as JSONL (the header on the first
 * line, then one event per line) in a code block that copies it, and a
 * download of the same text as `<sessionId>.jsonl`. The log is read when the
 * view opens. Sessions are end users' records, so the original Studio's raw
 * edit is not offered.
 * @module @lyteboat/studio-web/client/studio-session-raw
 */

import { useCallback, useMemo } from 'react'
import type { StudioSessionRaw } from '@lyteboat/contracts/studio'
import { studioApi } from './studio-api-client.ts'
import { useStudioCall } from './studio-call-state.ts'
import { StudioCodeBody, downloadStudioFile } from './studio-code-body.tsx'
import { DownloadIcon } from './studio-icons.tsx'

function studioSessionJsonl(raw: StudioSessionRaw): string {
  return `${[raw.header, ...raw.events].map(line => JSON.stringify(line)).join('\n')}\n`
}

/** The Raw view of one session, mounted per session. */
export function StudioSessionRawView({ agentId, sessionId }: { agentId: string; sessionId: string }) {
  const raw = useStudioCall(useCallback(() => studioApi.sessionRaw(agentId, sessionId), [agentId, sessionId]))
  const text = useMemo(() => raw.answer === null ? '' : studioSessionJsonl(raw.answer), [raw.answer])

  if (raw.error !== null) return <div className="empty-surface">{raw.error}</div>
  if (raw.answer === null) return <div className="empty-surface">Loading raw log...</div>
  const { events, inheritedEventCount } = raw.answer
  return (
    <div className="session-raw-drawer session-raw-view">
      <div className="session-raw-drawer-head">
        <span className="kv-label" title={inheritedEventCount > 0 ? `开头的 ${String(inheritedEventCount)} 条事件是导入的历史` : undefined}>
          Raw JSONL · {events.length} events{inheritedEventCount > 0 ? ` · ${String(inheritedEventCount)} inherited` : ''}
        </span>
        <div className="button-row">
          <button className="action-button" onClick={() => downloadStudioFile(`${sessionId}.jsonl`, text, 'application/jsonl')} title="Download raw JSONL" type="button">
            <DownloadIcon />
            Download
          </button>
        </div>
      </div>
      <StudioCodeBody value={text}>
        <pre className="code-block">{text}</pre>
      </StudioCodeBody>
    </div>
  )
}
