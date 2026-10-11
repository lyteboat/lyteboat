/**
 * An agent's Sessions, laid out as the original Studio's: the collapsible list
 * rail (its window, toggles, search, and rows, 50 at a time as it scrolls)
 * beside the selected session's detail. The section keeps the rail's state:
 * the window, the toggles (applied to the rows read so far), the search text
 * (debounced; a search reads the server's matches instead of the list), and
 * the pages read. The selection is the URL's `?session=<id>` (else the newest
 * listed session), so a link opens a session even outside the window; a
 * `&turn=<n>` with it (the test window's 看过程) scrolls to that turn and
 * marks it, until another session is picked. The
 * trace link template is read once, and a Studio without one shows no links.
 * @module @lyteboat/studio-web/client/studio-agent-sessions
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { StudioSessionSummary } from '@lyteboat/contracts/studio'
import { studioApi } from './studio-api-client.ts'
import { useStudioCall } from './studio-call-state.ts'
import { StudioCollapsedRail, useStudioRailCollapse } from './studio-collapsible-rail.tsx'
import { StudioSessionPane } from './studio-session-detail.tsx'
import { StudioSessionRail, type StudioSessionRailModel } from './studio-session-list.tsx'
import { useStudioSessionPager } from './studio-session-pager.ts'
import { useStudioSessionWindow } from './studio-session-window.tsx'

const STUDIO_SESSION_PAGE_SIZE = 50
const STUDIO_SESSION_SEARCH_DEBOUNCE_MS = 300

function studioSessionPassesToggles(session: StudioSessionSummary, anomalyOnly: boolean, interceptedOnly: boolean): boolean {
  // As the original Studio's 仅看异常: tool failures and errored turns, not slow calls.
  if (anomalyOnly && session.errorCount === 0) return false
  // The original Studio's 拦截 was a turn stopped before its loop ran; here that is a turn the
  // admission answered (rejected) or one cancelled (aborted).
  if (interceptedOnly && session.rejectedCount === 0 && session.abortedCount === 0) return false
  return true
}

/** The rail's state, kept by the section so a collapsed rail loses nothing. */
function useStudioSessionRailModel(agentId: string): StudioSessionRailModel {
  const sessionWindow = useStudioSessionWindow()
  const [query, setQuery] = useState('')
  const [searchText, setSearchText] = useState('')
  const [anomalyOnly, setAnomalyOnly] = useState(false)
  const [interceptedOnly, setInterceptedOnly] = useState(false)
  const [groupByOwner, setGroupByOwner] = useState(false)

  useEffect(() => {
    const handle = window.setTimeout(() => setSearchText(query.trim()), STUDIO_SESSION_SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(handle)
  }, [query])

  const range = sessionWindow.window
  const readListPage = useCallback(
    (offset: number) => studioApi.sessions(agentId, { ...range, limit: STUDIO_SESSION_PAGE_SIZE, offset }),
    [agentId, range],
  )
  const readSearchPage = useMemo(() => searchText === ''
    ? null
    : (offset: number) => studioApi.findSessions(agentId, { q: searchText, ...range, limit: STUDIO_SESSION_PAGE_SIZE, offset }),
  [agentId, range, searchText])
  const list = useStudioSessionPager(readListPage)
  const search = useStudioSessionPager(readSearchPage)
  const visible = useMemo(
    () => list.sessions.filter(session => studioSessionPassesToggles(session, anomalyOnly, interceptedOnly)),
    [list.sessions, anomalyOnly, interceptedOnly],
  )

  return {
    sessionWindow,
    query,
    setQuery,
    searchText,
    anomalyOnly: { on: anomalyOnly, set: setAnomalyOnly },
    interceptedOnly: { on: interceptedOnly, set: setInterceptedOnly },
    groupByOwner: { on: groupByOwner, set: setGroupByOwner },
    list,
    search,
    visible,
  }
}

/** The Sessions section of an agent's workspace. */
export function StudioAgentSessions({ agentId }: { agentId: string }) {
  const model = useStudioSessionRailModel(agentId)
  const traceLink = useStudioCall(useCallback(() => studioApi.traceLink(), []))
  const [searchParams, setSearchParams] = useSearchParams()
  const [collapsed, toggleCollapsed] = useStudioRailCollapse('agent-sessions')
  const requested = searchParams.get('session')
  const focusTurn = Number(searchParams.get('turn') ?? Number.NaN)
  const selectedId = requested === null || requested === '' ? model.list.sessions[0]?.sessionId : requested
  const select = useCallback((sessionId: string): void => {
    setSearchParams({ session: sessionId }, { replace: true })
  }, [setSearchParams])

  return (
    <section className={`workspace-split workspace-sessions ${collapsed ? 'list-collapsed' : ''}`}>
      {collapsed
        ? <StudioCollapsedRail count={model.searchText === '' ? model.visible.length : model.search.sessions.length} label="Sessions" onExpand={toggleCollapsed} />
        : <StudioSessionRail model={model} onCollapse={toggleCollapsed} onSelect={select} selectedId={selectedId} />}
      <div className="workspace-surface split-detail session-detail-panel">
        <div aria-atomic="true" aria-live="polite" className="sr-only">
          {selectedId === undefined ? 'No session selected' : `Viewing session ${selectedId}`}
        </div>
        {selectedId === undefined
          ? <div className="empty-surface">Select a session to inspect evidence.</div>
          : <StudioSessionPane agentId={agentId} focusTurn={Number.isInteger(focusTurn) ? focusTurn : undefined} key={selectedId} sessionId={selectedId} traceTemplate={traceLink.answer?.template} />}
      </div>
    </section>
  )
}
