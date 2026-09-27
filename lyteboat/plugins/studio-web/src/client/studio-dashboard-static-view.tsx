/**
 * The Dashboard's static view, as the original Studio's: a bar with the
 * totals and the last activity, the metric cards (agents; skills, users, and
 * sessions with their six-month trends; tools with their total only), the
 * skills and sessions coverage (figures and two distributions each), the
 * Running messages panel, and the activity feed (sessions, skills, and eval
 * runs), filterable by kind. lyteboat keeps no memory, so there is no Memory
 * card; the skills distributions are skills per agent and the tools skills
 * require, where the original Studio had skill groups and tags. The summary
 * loads once the radar has, and again after each refresh of it.
 * @module @lyteboat/studio-web/client/studio-dashboard-static-view
 */

import { useCallback, useState } from 'react'
import type { StudioActivityItem, StudioDashboardSummary, StudioDistributionItem, StudioInsightStat, StudioTrendPoint } from '@lyteboat/contracts/studio'
import { studioApi } from './studio-api-client.ts'
import { useStudioCall } from './studio-call-state.ts'
import { StudioMiniTrendChart, type StudioDashboardTone } from './studio-dashboard-charts.tsx'
import { formatStudioDashboardCount } from './studio-dashboard-format.ts'
import { StudioDashboardNotice } from './studio-dashboard-notice.tsx'
import { StudioDashboardRunningPanel } from './studio-dashboard-running-panel.tsx'
import { RefreshIcon } from './studio-icons.tsx'
import { formatStudioRelativeTime } from './studio-relative-time.ts'
import { useStudioShell } from './studio-shell.tsx'

type StudioActivityFilter = 'all' | StudioActivityItem['kind']

const STUDIO_ACTIVITY_FILTERS: readonly (readonly [StudioActivityFilter, string])[] = [['all', 'All'], ['session', 'Sessions'], ['skill', 'Skills'], ['eval', 'Evals']]
const STUDIO_ACTIVITY_LETTER: Record<StudioActivityItem['kind'], string> = { skill: 'K', session: 'S', eval: 'E' }
const STUDIO_STATIC_LOADING_TEXT = 'Collecting agents, skills, tools, and sessions across the current workspace.'

function studioTrendDelta(points: readonly StudioTrendPoint[]): number {
  return (points.at(-1)?.value ?? 0) - (points[0]?.value ?? 0)
}

function StudioDashboardMetricCard({ tone, label, value, points }: { tone: StudioDashboardTone; label: string; value: number; points?: readonly StudioTrendPoint[] }) {
  const delta = points === undefined ? 0 : studioTrendDelta(points)
  const direction = delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat'
  const trendLabel = points !== undefined && points.length > 1 ? `${delta >= 0 ? '+' : ''}${formatStudioDashboardCount(delta)} in ${String(points.length)}m` : null
  return (
    <article className={`workspace-surface dashboard-metric-card metric-tone-${tone}`}>
      <div className="dashboard-metric-card-head">
        <span>{label}</span>
      </div>
      <div className="dashboard-metric-card-main">
        <strong>{formatStudioDashboardCount(value)}</strong>
        {trendLabel !== null && <div className={`dashboard-metric-delta trend-${direction}`}>{trendLabel}</div>}
      </div>
      {points !== undefined && (
        <div className="dashboard-card-trend">
          <StudioMiniTrendChart points={points} tone={tone} />
          <div aria-hidden="true" className="dashboard-card-trend-labels">
            <span>{points[0]?.shortLabel}</span>
            <span>{points.at(-1)?.shortLabel}</span>
          </div>
        </div>
      )}
    </article>
  )
}

function StudioInsightStatTile({ stat }: { stat: StudioInsightStat }) {
  return (
    <div className="dashboard-insight-stat">
      <span>{stat.label}</span>
      <strong>{stat.value}</strong>
      {stat.hint !== undefined && <small>{stat.hint}</small>}
    </div>
  )
}

function StudioDistributionCard({ title, items, emptyLabel, tone }: { title: string; items: readonly StudioDistributionItem[]; emptyLabel: string; tone: StudioDashboardTone }) {
  const maxValue = Math.max(...items.map(item => item.value), 1)
  return (
    <section className={`dashboard-distribution-card metric-tone-${tone}`}>
      <div className="dashboard-distribution-head"><strong>{title}</strong></div>
      {items.length === 0 ? <div className="dashboard-chart-empty">{emptyLabel}</div> : (
        <div className="dashboard-distribution-list">
          {items.map(item => (
            <div className="dashboard-distribution-item" key={item.label}>
              <div className="dashboard-distribution-item-head">
                <div className="dashboard-distribution-copy">
                  <span title={item.label}>{item.label}</span>
                  {item.hint !== undefined && <small>{item.hint}</small>}
                </div>
                <strong>{formatStudioDashboardCount(item.value)}</strong>
              </div>
              <div className="dashboard-distribution-bar">
                <div className="dashboard-distribution-bar-fill" style={{ width: `${String(Math.max((item.value / maxValue) * 100, 6))}%` }} />
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

function StudioActivityFeed({ items }: { items: readonly StudioActivityItem[] }) {
  const [filter, setFilter] = useState<StudioActivityFilter>('all')
  const visible = filter === 'all' ? items : items.filter(item => item.kind === filter)
  return (
    <article className="workspace-surface">
      <div className="surface-heading">
        <span>Activity</span>
        <div className="button-row">
          {STUDIO_ACTIVITY_FILTERS.map(([kind, label]) => (
            <button className={`chip ${filter === kind ? 'active' : ''}`} key={kind} onClick={() => setFilter(kind)} type="button">{label}</button>
          ))}
        </div>
      </div>
      {visible.length === 0 ? <div className="empty-surface">No recent activity.</div> : (
        <div className="activity">
          {visible.map((item, index) => (
            <div className="act-row" key={`${String(item.time)}-${item.agentId}-${item.kind}-${String(index)}`}>
              <div className="act-time">{formatStudioRelativeTime(item.time, { ago: false })}</div>
              <div className={`act-icon ${item.status}`}>{STUDIO_ACTIVITY_LETTER[item.kind]}</div>
              <div className="act-text"><span className="agent">[{item.agentLabel}]</span>{item.text}</div>
              <div className="act-kind">{item.kind}</div>
            </div>
          ))}
        </div>
      )}
    </article>
  )
}

function StudioCoverage({ summary }: { summary: StudioDashboardSummary }) {
  return (
    <section className="dashboard-insight-grid dashboard-insight-grid-coverage">
      <article className="workspace-surface dashboard-insight-panel dashboard-insight-panel-skills metric-tone-skills">
        <div className="surface-heading dashboard-insight-heading">
          <span>Skills coverage</span><b>{formatStudioDashboardCount(summary.totalSkills)} total</b>
        </div>
        <div className="dashboard-insight-stat-grid dashboard-insight-stat-grid-skills">
          {summary.skills.stats.map(stat => <StudioInsightStatTile key={stat.label} stat={stat} />)}
        </div>
        <div className="dashboard-distribution-grid">
          <StudioDistributionCard emptyLabel="No skills yet" items={summary.skills.agents} title="Skills by Agent" tone="skills" />
          <StudioDistributionCard emptyLabel="No required tools" items={summary.skills.requiredTools} title="Required Tools" tone="skills" />
        </div>
      </article>

      <article className="workspace-surface dashboard-insight-panel dashboard-insight-panel-sessions metric-tone-sessions">
        <div className="surface-heading dashboard-insight-heading">
          <span>Sessions coverage</span><b>{formatStudioDashboardCount(summary.totalSessions)} total</b>
        </div>
        <div className="dashboard-insight-stat-grid">
          {summary.sessions.stats.map(stat => <StudioInsightStatTile key={stat.label} stat={stat} />)}
        </div>
        <div className="dashboard-distribution-grid dashboard-distribution-grid-stacked">
          <StudioDistributionCard emptyLabel="No sessions yet" items={summary.sessions.agents} title="Sessions by Agent" tone="sessions" />
          <StudioDistributionCard emptyLabel="No session messages" items={summary.sessions.messageBands} title="Message Count Bands" tone="sessions" />
        </div>
      </article>
      <StudioDashboardRunningPanel />
    </section>
  )
}

function StudioStaticContent() {
  const { agentsError, refreshAgents } = useStudioShell()
  const { answer: summary, error } = useStudioCall(useCallback(() => studioApi.dashboardSummary(), []))

  if (agentsError !== null || error !== null) return <StudioDashboardNotice heading="Dashboard" text={agentsError ?? error ?? ''} title="Unable to load dashboard" />
  if (summary === null) return <StudioDashboardNotice heading="Dashboard" text={STUDIO_STATIC_LOADING_TEXT} title="Loading studio telemetry..." />
  const lastActivity = summary.activity[0]
  return (
    <div className="dashboard-view-content">
      <div className="workspace-surface health-filter-bar dashboard-static-filter-bar">
        <span>{summary.totalAgents} agents · {formatStudioDashboardCount(summary.totalSessions)} sessions · last activity {lastActivity === undefined ? '—' : formatStudioRelativeTime(lastActivity.time)}</span>
        <button className="btn btn-sm" onClick={() => void refreshAgents()} type="button"><RefreshIcon /> 刷新</button>
      </div>

      <section className="dashboard-metric-grid dashboard-metric-grid-five">
        <StudioDashboardMetricCard label="Total Agents" tone="agents" value={summary.totalAgents} />
        <StudioDashboardMetricCard label="Total Skills" points={summary.trends.skills} tone="skills" value={summary.totalSkills} />
        <StudioDashboardMetricCard label="Total Tools" tone="tools" value={summary.totalTools} />
        <StudioDashboardMetricCard label="Total Users" points={summary.trends.users} tone="users" value={summary.totalUsers} />
        <StudioDashboardMetricCard label="Total Sessions" points={summary.trends.sessions} tone="sessions" value={summary.totalSessions} />
      </section>

      <StudioCoverage summary={summary} />

      <section className="dashboard-row-2"><StudioActivityFeed items={summary.activity} /></section>
    </div>
  )
}

/** The static view; a refresh of the radar mounts its content anew, which reads the summary again. */
export function StudioDashboardStaticView() {
  const { agentsLoading } = useStudioShell()
  if (agentsLoading) return <StudioDashboardNotice heading="Dashboard" text={STUDIO_STATIC_LOADING_TEXT} title="Loading studio telemetry..." />
  return <StudioStaticContent />
}
