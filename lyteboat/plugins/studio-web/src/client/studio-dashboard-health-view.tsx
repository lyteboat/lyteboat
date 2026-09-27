/**
 * The Dashboard's performance view, as the original Studio's: the filter bar,
 * three lanes over the window's buckets (request volume with peak concurrent
 * users, response performance, tool performance) on one time axis, the tool
 * and skill rankings, and the table of the buckets that had requests. Each
 * lane's figures carry their change against the comparison window when one is
 * on. The health loads once the radar has, and again on every change of the
 * filter or a refresh; while it loads, and when a reload fails, the last
 * answer stays on screen, and an answer that arrives after the filter changed
 * is dropped.
 * @module @lyteboat/studio-web/client/studio-dashboard-health-view
 */

import { useEffect, useMemo, useState } from 'react'
import type { StudioDashboardHealth, StudioHealthAggregate, StudioHealthSeriesPoint } from '@lyteboat/contracts/studio'
import { studioApi, studioErrorMessage } from './studio-api-client.ts'
import { StudioHealthLane, StudioHealthTimeAxis, type StudioHealthChartMetric, type StudioHealthLaneFigure } from './studio-dashboard-charts.tsx'
import { formatStudioDashboardCount, formatStudioDashboardDateTime, formatStudioDashboardDuration, formatStudioDashboardRatio } from './studio-dashboard-format.ts'
import { StudioHealthFilterBar, studioHealthFilterInitial, studioHealthFilterInvalid, studioHealthQuery } from './studio-dashboard-health-filter.tsx'
import { StudioDashboardNotice } from './studio-dashboard-notice.tsx'
import { useStudioShell } from './studio-shell.tsx'

/** The health as the view shows it: the last answer, whether a load is on its way, and why the last one failed. */
interface StudioHealthState {
  health: StudioDashboardHealth | null
  loading: boolean
  error: string | null
}

/** One row of a ranking. */
interface StudioHealthRankingRow {
  label: string
  count: number
  meta: string
}

const formatStudioHealthCount = (value: number | null): string => formatStudioDashboardCount(value ?? 0)
const formatStudioHealthRatio = (value: number | null): string => formatStudioDashboardRatio(value ?? 0)

const STUDIO_REQUEST_METRICS: StudioHealthChartMetric[] = [
  { key: 'requestCount', label: '请求量', color: 'var(--accent)', format: formatStudioHealthCount, mode: 'bar' },
  { key: 'peakConcurrentUsers', label: '并发用户', color: 'var(--ok)', format: formatStudioHealthCount, axis: 'secondary', area: true, showWithoutRequests: true },
]
const STUDIO_RESPONSE_METRICS: StudioHealthChartMetric[] = [
  { key: 'firstContentP95Ms', label: '首内容 P95', color: 'var(--accent)', format: formatStudioDashboardDuration },
  { key: 'durationP95Ms', label: '总耗时 P95', color: 'var(--warn)', format: formatStudioDashboardDuration },
]
const STUDIO_TOOL_METRICS: StudioHealthChartMetric[] = [
  { key: 'toolCallCount', label: '调用量', color: 'var(--accent)', format: formatStudioHealthCount, mode: 'bar' },
  { key: 'toolErrorCount', label: '失败量', color: 'var(--err)', format: formatStudioHealthCount, mode: 'bar' },
]

/**
 * @param load - the call for the current filter, memoized on it; null asks for nothing (the radar is loading, or the filter is invalid).
 * @returns the health state; the answer of a call that was replaced is dropped.
 */
function useStudioHealthState(load: (() => Promise<StudioDashboardHealth>) | null): StudioHealthState {
  const [state, setState] = useState<StudioHealthState>({ health: null, loading: true, error: null })
  useEffect(() => {
    if (load === null) return undefined
    let cancelled = false
    setState(previous => ({ ...previous, loading: true, error: null }))
    const run = async (): Promise<void> => {
      try {
        const health = await load()
        if (!cancelled) setState({ health, loading: false, error: null })
      } catch (error: unknown) {
        if (!cancelled) setState(previous => ({ ...previous, loading: false, error: studioErrorMessage(error) }))
      }
    }
    void run()
    return () => { cancelled = true }
  }, [load])
  return state
}

function studioHealthDelta(current: number | null, compared: number | null | undefined, format: (value: number | null) => string): string | null {
  if (current === null || compared === null || compared === undefined) return null
  const delta = current - compared
  return `${delta >= 0 ? '+' : ''}${format(delta)}`
}

function studioHealthFigure(label: string, value: string, current: number | null, compared: number | null | undefined, format: (value: number | null) => string): StudioHealthLaneFigure {
  return { label, value, comparison: studioHealthDelta(current, compared, format) }
}

function studioHealthLaneFigures(summary: StudioHealthAggregate, compared: StudioHealthAggregate | undefined): { request: StudioHealthLaneFigure[]; response: StudioHealthLaneFigure[]; tool: StudioHealthLaneFigure[] } {
  return {
    request: [
      studioHealthFigure('请求量', formatStudioDashboardCount(summary.requestCount), summary.requestCount, compared?.requestCount, formatStudioHealthCount),
      studioHealthFigure('活跃用户数', formatStudioDashboardCount(summary.activeUsers), summary.activeUsers, compared?.activeUsers, formatStudioHealthCount),
    ],
    response: [
      studioHealthFigure('请求平均轮次', `${formatStudioDashboardRatio(summary.averageTurns)} 轮`, summary.averageTurns, compared?.averageTurns, formatStudioHealthRatio),
      studioHealthFigure('请求平均耗时', formatStudioDashboardDuration(summary.averageDurationMs), summary.averageDurationMs, compared?.averageDurationMs, formatStudioDashboardDuration),
      studioHealthFigure('单轮平均耗时', formatStudioDashboardDuration(summary.averageTurnDurationMs), summary.averageTurnDurationMs, compared?.averageTurnDurationMs, formatStudioDashboardDuration),
    ],
    tool: [
      studioHealthFigure('工具调用量', formatStudioDashboardCount(summary.toolCallCount), summary.toolCallCount, compared?.toolCallCount, formatStudioHealthCount),
      studioHealthFigure('工具平均耗时', formatStudioDashboardDuration(summary.averageToolDurationMs), summary.averageToolDurationMs, compared?.averageToolDurationMs, formatStudioDashboardDuration),
    ],
  }
}

function StudioHealthRanking({ title, subtitle, rows, emptyText, tone }: {
  title: string
  subtitle: string
  rows: readonly StudioHealthRankingRow[]
  emptyText: string
  tone: 'tool' | 'skill'
}) {
  const maxCount = Math.max(...rows.map(row => row.count), 1)
  return (
    <article className={`workspace-surface health-ranking-panel health-ranking-${tone}`}>
      <div className="health-panel-heading">
        <div><strong>{title}</strong><span>{subtitle}</span></div>
      </div>
      <div className="health-ranking-content">
        {rows.length === 0 ? <div className="health-ranking-empty">{emptyText}</div> : (
          <ol className="health-ranking-list">
            {rows.map(row => (
              <li key={row.label}>
                <div>
                  <span>{row.label}</span>
                  <b>{row.count} 次 · {row.meta}</b>
                </div>
                <i><span style={{ width: `${String((row.count / maxCount) * 100)}%` }} /></i>
              </li>
            ))}
          </ol>
        )}
      </div>
    </article>
  )
}

function StudioHealthBucketTable({ points }: { points: readonly StudioHealthSeriesPoint[] }) {
  const populated = points.filter(point => point.requestCount > 0)
  return (
    <article className="workspace-surface health-bucket-panel">
      <div className="health-panel-heading">
        <div><strong>时间桶明细</strong><span>用于发现局部退化，而不是链路根因分析</span></div>
      </div>
      {populated.length === 0 ? <div className="empty-surface">该时间范围暂无运行数据。</div> : (
        <div className="health-table-scroll">
          <table className="health-bucket-table">
            <thead>
              <tr><th>时间</th><th>请求</th><th>平均轮次</th><th>单轮平均耗时</th><th>请求平均耗时</th><th>工具调用</th><th>工具失败</th></tr>
            </thead>
            <tbody>
              {populated.map(point => (
                <tr key={point.bucketIndex}>
                  <td>{formatStudioDashboardDateTime(point.startedAt)}</td>
                  <td>{point.requestCount}</td>
                  <td>{formatStudioDashboardRatio(point.averageTurns)}</td>
                  <td>{formatStudioDashboardDuration(point.averageTurnDurationMs)}</td>
                  <td>{formatStudioDashboardDuration(point.averageDurationMs)}</td>
                  <td>{point.toolCallCount}</td>
                  <td className={point.toolErrorCount > 0 ? 'health-value-danger' : ''}>{point.toolErrorCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </article>
  )
}

function StudioHealthContent({ health }: { health: StudioDashboardHealth }) {
  const figures = studioHealthLaneFigures(health.current.summary, health.comparison?.summary)
  return (
    <>
      <article className="workspace-surface health-chart-lanes">
        <StudioHealthLane figures={figures.request} health={health} metrics={STUDIO_REQUEST_METRICS} subtitle="吞吐与峰值并发用户趋势" title="请求量" />
        <StudioHealthLane figures={figures.response} health={health} metrics={STUDIO_RESPONSE_METRICS} subtitle="首内容与端到端耗时趋势" title="响应性能" />
        <StudioHealthLane figures={figures.tool} health={health} metrics={STUDIO_TOOL_METRICS} subtitle="调用量与失败量趋势" title="工具性能" />
        <StudioHealthTimeAxis health={health} />
      </article>

      <section className="health-ranking-grid">
        <StudioHealthRanking
          emptyText="暂无工具调用"
          rows={health.current.toolRankings.map(tool => ({ label: tool.name, count: tool.count, meta: `平均 ${formatStudioDashboardDuration(tool.averageDurationMs)}` }))}
          subtitle="业务工具调用次数 · 不含 Skill 加载"
          title="工具调用排行"
          tone="tool"
        />
        <StudioHealthRanking
          emptyText="暂无 Skill 调用"
          rows={health.current.skillRankings.map(skill => ({ label: skill.skillId, count: skill.count, meta: `平均 ${formatStudioDashboardRatio(skill.averageTurns)} 轮` }))}
          subtitle="按关联 Run 计数 · 同一 Run 内去重"
          title="技能调用排行"
          tone="skill"
        />
      </section>

      <StudioHealthBucketTable points={health.current.series} />
    </>
  )
}

/** The performance view. */
export function StudioDashboardHealthView() {
  const { agents, agentsLoading, agentsError, refreshAgents } = useStudioShell()
  const [filter, setFilter] = useState(studioHealthFilterInitial)
  const [refreshKey, setRefreshKey] = useState(0)
  const invalid = studioHealthFilterInvalid(filter)
  const load = useMemo(
    () => agentsLoading || invalid ? null : () => studioApi.dashboardHealth(studioHealthQuery(filter, Date.now())),
    // refreshKey is not read: a refresh only needs a new call, whose preset range then ends at the refresh.
    [agentsLoading, invalid, filter, refreshKey],
  )
  const { health, loading, error } = useStudioHealthState(load)

  if ((agentsLoading || loading) && health === null) return <StudioDashboardNotice heading="Agent Health" text="读取请求耗时、执行轮次和工具调用摘要。" title="正在聚合智能体运行指标…" />
  if (agentsError !== null || (health === null && error !== null)) return <StudioDashboardNotice heading="Agent Health" text={agentsError ?? error ?? ''} title="无法加载健康数据" />
  if (health === null) return null

  const refresh = (): void => {
    void refreshAgents()
    setRefreshKey(key => key + 1)
  }
  return (
    <div className="dashboard-view-content">
      <StudioHealthFilterBar agents={agents} filter={filter} loading={loading} onChange={setFilter} onRefresh={refresh} />
      {error !== null && <div className="health-inline-error">刷新失败，当前仍显示上一次数据：{error}</div>}
      {health.current.summary.requestCount === 0 && <div className="health-empty-window">当前时间范围还没有 Run 数据。新请求完成后会自动进入统计。</div>}
      <StudioHealthContent health={health} />
    </div>
  )
}
