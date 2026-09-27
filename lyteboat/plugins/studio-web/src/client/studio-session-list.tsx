/**
 * The Sessions list rail, laid out as the original Studio's: the heading with
 * its toggles (仅看异常, 仅看拦截, 按用户分组) and the count, the search box,
 * the time window, and the rows, newest first, scrolled in 50 at a time. A row
 * shows the session's latest question, its badges (errors, slow calls,
 * rejected and aborted turns, a turn still open, imported history), its
 * message count, and when it was last updated. While a search runs, the rows
 * are its matches with where each matched; grouped, the rows sit under their
 * owners. The section keeps the rail's state, so collapsing the rail loses
 * nothing.
 * @module @lyteboat/studio-web/client/studio-session-list
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { StudioSessionMatch, StudioSessionMatchKind, StudioSessionSummary } from '@lyteboat/contracts/studio'
import { StudioRailToggle } from './studio-collapsible-rail.tsx'
import { ChevronRightIcon } from './studio-icons.tsx'
import { formatStudioRelativeTime } from './studio-relative-time.ts'
import { StudioSearchBox } from './studio-search-box.tsx'
import { formatStudioSessionTime, studioSessionOwnerLabel, summarizeStudioSessionText } from './studio-session-format.ts'
import type { StudioSessionPager } from './studio-session-pager.ts'
import { StudioSessionWindowPanel, type StudioSessionWindowState } from './studio-session-window.tsx'
import { StudioSwitch } from './studio-switch.tsx'
import { toggledStudioSet } from './studio-toggled-set.ts'

/** The longest search text the server takes. */
const STUDIO_SESSION_SEARCH_MAX = 200
const STUDIO_SESSION_MATCH_LABEL: Record<StudioSessionMatchKind, string> = { question: 'QUESTION', trace: 'TRACE', session: 'SESSION' }

/** One of the heading's toggles. */
interface StudioSessionToggle {
  on: boolean
  set(on: boolean): void
}

/** What the rail shows and what its controls change; the section holds it. */
export interface StudioSessionRailModel {
  sessionWindow: StudioSessionWindowState
  query: string
  setQuery(query: string): void
  /** The search text in force (debounced); empty while the list shows. */
  searchText: string
  anomalyOnly: StudioSessionToggle
  interceptedOnly: StudioSessionToggle
  groupByOwner: StudioSessionToggle
  list: StudioSessionPager<StudioSessionSummary>
  search: StudioSessionPager<StudioSessionMatch>
  /** The listed sessions the toggles let through. */
  visible: StudioSessionSummary[]
}

/** The badges of a session with something to flag; nothing when it has none. */
export function StudioSessionBadges({ session }: { session: StudioSessionSummary }) {
  const { errorCount, slowCount, rejectedCount, abortedCount, openTurn, seeded } = session
  if (errorCount + slowCount + rejectedCount + abortedCount === 0 && !openTurn && !seeded) return null
  return (
    <span className="session-row-badges">
      {errorCount > 0 && <span className="session-badge badge-err" title="失败的工具调用与出错的轮次">{errorCount} err</span>}
      {slowCount > 0 && <span className="session-badge badge-slow" title="10 秒及以上的模型回答与工具调用">{slowCount} slow</span>}
      {rejectedCount > 0 && <span className="session-badge badge-abort" title="准入代答、未进模型的轮次">{rejectedCount} reject</span>}
      {abortedCount > 0 && <span className="session-badge badge-cancel" title="被取消的轮次">{abortedCount} abort</span>}
      {openTurn && <span className="session-badge badge-open" title="最后一轮没有结束：仍在执行，或进程已退出">进行中</span>}
      {seeded && <span className="session-badge badge-imported" title="会话以导入的历史开头；导入部分不计入各项计数">imported</span>}
    </span>
  )
}

function StudioSessionRowMeta({ session }: { session: StudioSessionSummary }) {
  return (
    <span className="session-row-meta">
      <StudioSessionBadges session={session} />
      <span className="session-row-count" title="消息数">{session.messageCount}</span>
      <span className="session-row-time" title={`updated ${formatStudioSessionTime(session.updatedAt)}`}>{formatStudioRelativeTime(session.updatedAt)}</span>
    </span>
  )
}

/** A session's row: its title and meta, and under the title a search match's `sub` line. */
function StudioSessionRow({ session, title, sub, active, onSelect }: { session: StudioSessionSummary; title: string; sub?: ReactNode; active: boolean; onSelect(sessionId: string): void }) {
  return (
    <button aria-label={`Session ${title}`} className={`session-row${sub === undefined ? '' : ' session-row-search'} ${active ? 'active' : ''}`} onClick={() => onSelect(session.sessionId)} onFocus={() => onSelect(session.sessionId)} type="button">
      <span className="session-row-main">
        <span className="session-row-title" title={title}>{title}</span>
        {sub}
      </span>
      <StudioSessionRowMeta session={session} />
    </button>
  )
}

/** A listed session's title: its latest question, else its first, else its id's head. */
function studioSessionRowTitle(session: StudioSessionSummary): string {
  return session.lastUserMessage ?? session.firstMessage ?? session.sessionId.slice(0, 14)
}

/** Where a search matched: its kind, and the matched text cut to one line. */
function StudioSessionMatchSub({ match }: { match: StudioSessionMatch }) {
  return (
    <span className="session-row-sub">
      <span className={`session-badge match-${match.matchKind}`}>{STUDIO_SESSION_MATCH_LABEL[match.matchKind]}</span>
      {match.matchedSnippet !== '' && <span className="session-row-snippet" title={match.matchedSnippet}>{summarizeStudioSessionText(match.matchedSnippet, 60)}</span>}
    </span>
  )
}

function StudioSessionOwnerGroup({ owner, index, sessions, collapsed, onToggle, selectedId, onSelect }: {
  owner: string
  index: number
  sessions: StudioSessionSummary[]
  collapsed: boolean
  onToggle(owner: string): void
  selectedId: string | undefined
  onSelect(sessionId: string): void
}) {
  const groupId = `session-owner-group-${String(index)}`
  return (
    <div className="session-cluster">
      <div className="session-cluster-head">
        <button aria-controls={groupId} aria-expanded={!collapsed} className={`session-cluster-toggle ${collapsed ? 'collapsed' : ''}`} onClick={() => onToggle(owner)} type="button">
          <span className="session-group-title">
            <ChevronRightIcon className="session-group-chevron" />
            <span>{owner}</span>
          </span>
          <span>{sessions.length}</span>
        </button>
      </div>
      <div className={`session-cluster-items ${collapsed ? 'collapsed' : ''}`} id={groupId}>
        {sessions.map(session => <StudioSessionRow active={session.sessionId === selectedId} key={session.sessionId} onSelect={onSelect} session={session} title={studioSessionRowTitle(session)} />)}
      </div>
    </div>
  )
}

function StudioSessionOwnerGroups({ sessions, selectedId, onSelect }: { sessions: StudioSessionSummary[]; selectedId: string | undefined; onSelect(sessionId: string): void }) {
  const [collapsedOwners, setCollapsedOwners] = useState<ReadonlySet<string>>(() => new Set())
  const groups = useMemo(() => {
    const byOwner = new Map<string, StudioSessionSummary[]>()
    for (const session of sessions) {
      const owner = studioSessionOwnerLabel(session.owner)
      const group = byOwner.get(owner)
      if (group === undefined) byOwner.set(owner, [session])
      else group.push(session)
    }
    return [...byOwner.entries()]
  }, [sessions])
  const toggle = (owner: string): void => { setCollapsedOwners(current => toggledStudioSet(current, owner)) }
  return (
    <>
      {groups.map(([owner, items], index) => (
        <StudioSessionOwnerGroup collapsed={collapsedOwners.has(owner)} index={index} key={owner} onSelect={onSelect} onToggle={toggle} owner={owner} selectedId={selectedId} sessions={items} />
      ))}
    </>
  )
}

/** The row at the list's end that asks for the next page once it scrolls into view. */
function StudioSessionSentinel({ loadMore, loadingMore }: { loadMore(): void; loadingMore: boolean }) {
  const sentinel = useRef<HTMLDivElement | null>(null)
  // Re-armed with every new `loadMore`: a fresh observer reports at once, so a page too short to scroll still reads the next.
  useEffect(() => {
    const node = sentinel.current
    if (node === null) return
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) loadMore()
    }, { root: null, threshold: 0.1 })
    observer.observe(node)
    return () => observer.disconnect()
  }, [loadMore])
  return <div aria-hidden="true" className="session-list-sentinel" ref={sentinel}>{loadingMore ? 'Loading more…' : ''}</div>
}

function StudioSessionPagerTail<T>({ pager }: { pager: StudioSessionPager<T> }) {
  if (pager.error !== null) return <div className="empty-surface">{pager.error}</div>
  return pager.hasMore ? <StudioSessionSentinel loadMore={pager.loadMore} loadingMore={pager.loadingMore} /> : null
}

function StudioSessionSearchRows({ model, selectedId, onSelect }: { model: StudioSessionRailModel; selectedId: string | undefined; onSelect(sessionId: string): void }) {
  const { search } = model
  return (
    <>
      {search.sessions.map(match => <StudioSessionRow active={match.sessionId === selectedId} key={match.sessionId} onSelect={onSelect} session={match} sub={<StudioSessionMatchSub match={match} />} title={match.firstMessage ?? match.sessionId.slice(0, 14)} />)}
      {search.loading && <div className="empty-surface">Searching…</div>}
      {!search.loading && search.error === null && search.sessions.length === 0 && <div className="empty-surface">No sessions match “{model.searchText}”.</div>}
      <StudioSessionPagerTail pager={search} />
    </>
  )
}

function StudioSessionListRows({ model, selectedId, onSelect }: { model: StudioSessionRailModel; selectedId: string | undefined; onSelect(sessionId: string): void }) {
  const { list, visible } = model
  const settled = !list.loading && list.error === null && !list.hasMore && visible.length === 0
  return (
    <>
      {model.groupByOwner.on
        ? <StudioSessionOwnerGroups onSelect={onSelect} selectedId={selectedId} sessions={visible} />
        : visible.map(session => <StudioSessionRow active={session.sessionId === selectedId} key={session.sessionId} onSelect={onSelect} session={session} title={studioSessionRowTitle(session)} />)}
      {list.loading && <div className="empty-surface">Loading sessions...</div>}
      {settled && list.sessions.length > 0 && <div className="empty-surface">没有符合筛选条件的会话。</div>}
      {settled && list.sessions.length === 0 && (
        <div className="empty-surface session-empty-window">
          <p>所选时间区间内没有会话更新。</p>
          <button className="action-button" onClick={model.sessionWindow.showRecent} type="button">查看最近 2 小时</button>
        </div>
      )}
      <StudioSessionPagerTail pager={list} />
    </>
  )
}

function StudioSessionHeadingToggle({ label, ariaLabel, toggle, disabled }: { label: string; ariaLabel: string; toggle: StudioSessionToggle; disabled: boolean }) {
  return (
    <span className="session-heading-toggle">
      <span>{label}</span>
      <StudioSwitch checked={toggle.on} disabled={disabled} label={ariaLabel} onChange={toggle.set} />
    </span>
  )
}

/** How many rows the rail shows: the toggles' survivors, or the matches so far (`+` while more follow). */
function studioSessionRailCount(model: StudioSessionRailModel): string {
  if (model.searchText === '') return String(model.visible.length)
  return `${String(model.search.sessions.length)}${model.search.hasMore ? '+' : ''} matches`
}

/** The expanded rail. */
export function StudioSessionRail({ model, selectedId, onSelect, onCollapse }: {
  model: StudioSessionRailModel
  selectedId: string | undefined
  onSelect(sessionId: string): void
  onCollapse(): void
}) {
  const searching = model.searchText !== ''
  return (
    <div className="workspace-surface split-list session-nav-panel">
      <div className="surface-heading">
        <span>Sessions</span>
        <span className="surface-heading-trail">
          <StudioSessionHeadingToggle ariaLabel="仅看异常" disabled={searching} label="仅看异常" toggle={model.anomalyOnly} />
          <StudioSessionHeadingToggle ariaLabel="仅看拦截" disabled={searching} label="仅看拦截" toggle={model.interceptedOnly} />
          <StudioSessionHeadingToggle ariaLabel="按用户分组" disabled={searching} label="按用户" toggle={model.groupByOwner} />
          <span>{studioSessionRailCount(model)}</span>
          <StudioRailToggle label="Collapse sessions" onToggle={onCollapse} />
        </span>
      </div>
      <StudioSearchBox label="Search sessions" maxLength={STUDIO_SESSION_SEARCH_MAX} onChange={model.setQuery} placeholder="Search questions, session IDs, trace IDs" value={model.query} />
      <StudioSessionWindowPanel state={model.sessionWindow} />
      <div aria-label="Sessions" className="session-nav-list" role="list">
        {searching
          ? <StudioSessionSearchRows model={model} onSelect={onSelect} selectedId={selectedId} />
          : <StudioSessionListRows model={model} onSelect={onSelect} selectedId={selectedId} />}
      </div>
    </div>
  )
}
