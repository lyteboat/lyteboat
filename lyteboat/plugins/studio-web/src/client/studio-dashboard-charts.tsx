/**
 * The Dashboard's charts, drawn in inline SVG as the original Studio draws
 * them. A health lane is one metric group over the window's buckets: its
 * figures on the left, then a legend with the latest populated bucket's
 * values, and the plot, where a metric is bars or a line (with an optional
 * area and a marker per bucket) on the primary or the secondary scale; the
 * comparison window is overlaid by bucket index, dashed. A bucket without
 * requests leaves a gap unless the metric is drawn regardless. The lanes share
 * one time axis. A metric card's sparkline is the six-month trend.
 * @module @lyteboat/studio-web/client/studio-dashboard-charts
 */

import type { StudioDashboardHealth, StudioHealthAggregate, StudioHealthSeriesPoint, StudioTrendPoint } from '@lyteboat/contracts/studio'
import { formatStudioDashboardClock, formatStudioDashboardDateTime } from './studio-dashboard-format.ts'

/** One metric a health lane plots. */
export interface StudioHealthChartMetric {
  key: keyof StudioHealthAggregate
  label: string
  color: string
  format(value: number | null): string
  mode?: 'bar' | 'line'
  axis?: 'primary' | 'secondary'
  area?: boolean
  /** Plot the metric in buckets without requests too (concurrent users). */
  showWithoutRequests?: boolean
}

/** One figure of a lane's summary, with its change against the comparison window. */
export interface StudioHealthLaneFigure {
  label: string
  value: string
  comparison: string | null
}

/** How a lane scales its metrics over its buckets. */
interface StudioHealthPlot {
  metrics: StudioHealthChartMetric[]
  pointCount: number
  scaleOf(metric: StudioHealthChartMetric): number
}

const STUDIO_HEALTH_CHART_WIDTH = 680
const STUDIO_HEALTH_CHART_HEIGHT = 118
const STUDIO_HEALTH_CHART_INSET_X = 18
const STUDIO_HEALTH_CHART_INSET_Y = 5
const STUDIO_HEALTH_GRID_LINES = [0, 0.25, 0.5, 0.75, 1]
const STUDIO_MINI_TREND_WIDTH = 132
const STUDIO_MINI_TREND_HEIGHT = 44

function studioHealthValue(point: StudioHealthSeriesPoint, metric: StudioHealthChartMetric): number | null {
  if (metric.showWithoutRequests !== true && point.requestCount === 0) return null
  return point[metric.key]
}

function studioHealthMax(points: readonly StudioHealthSeriesPoint[], metrics: readonly StudioHealthChartMetric[]): number {
  const values = points.flatMap(point => metrics.flatMap(metric => point[metric.key] ?? []))
  return Math.max(...values, 1)
}

function studioHealthChartPoint(index: number, value: number, maxValue: number, pointCount: number): { x: number; y: number } {
  const innerWidth = STUDIO_HEALTH_CHART_WIDTH - STUDIO_HEALTH_CHART_INSET_X * 2
  const innerHeight = STUDIO_HEALTH_CHART_HEIGHT - STUDIO_HEALTH_CHART_INSET_Y * 2
  return {
    x: STUDIO_HEALTH_CHART_INSET_X + ((index + 0.5) / pointCount) * innerWidth,
    y: STUDIO_HEALTH_CHART_INSET_Y + (1 - value / maxValue) * innerHeight,
  }
}

function studioHealthChartBar(index: number, value: number, maxValue: number, pointCount: number, seriesIndex: number, seriesCount: number): { x: number; y: number; width: number; height: number } {
  const innerWidth = STUDIO_HEALTH_CHART_WIDTH - STUDIO_HEALTH_CHART_INSET_X * 2
  const groupWidth = Math.min(24, (innerWidth / pointCount) * 0.72)
  const seriesSlotWidth = groupWidth / seriesCount
  const barWidth = Math.max(1.5, seriesSlotWidth - 1)
  const center = STUDIO_HEALTH_CHART_INSET_X + ((index + 0.5) / pointCount) * innerWidth
  const { y } = studioHealthChartPoint(index, value, maxValue, pointCount)
  return {
    x: center - groupWidth / 2 + seriesIndex * seriesSlotWidth + (seriesSlotWidth - barWidth) / 2,
    y,
    width: barWidth,
    height: Math.max(value === 0 ? 0 : 2, STUDIO_HEALTH_CHART_HEIGHT - STUDIO_HEALTH_CHART_INSET_Y - y),
  }
}

function studioHealthLinePath(points: readonly StudioHealthSeriesPoint[], metric: StudioHealthChartMetric, plot: StudioHealthPlot): string {
  const commands: string[] = []
  let drawing = false
  points.forEach((point, index) => {
    const value = studioHealthValue(point, metric)
    if (value === null) {
      drawing = false
      return
    }
    const { x, y } = studioHealthChartPoint(index, value, plot.scaleOf(metric), plot.pointCount)
    commands.push(`${drawing ? 'L' : 'M'} ${x.toFixed(1)} ${y.toFixed(1)}`)
    drawing = true
  })
  return commands.join(' ')
}

function studioHealthAreaPath(points: readonly StudioHealthSeriesPoint[], metric: StudioHealthChartMetric, plot: StudioHealthPlot): string {
  const baseline = STUDIO_HEALTH_CHART_HEIGHT - STUDIO_HEALTH_CHART_INSET_Y
  const paths: string[] = []
  let segment: { x: number; y: number }[] = []
  const close = (): void => {
    const first = segment[0]
    const last = segment.at(-1)
    if (first === undefined || last === undefined) return
    paths.push([
      `M ${first.x.toFixed(1)} ${String(baseline)}`,
      ...segment.map(point => `L ${point.x.toFixed(1)} ${point.y.toFixed(1)}`),
      `L ${last.x.toFixed(1)} ${String(baseline)} Z`,
    ].join(' '))
    segment = []
  }
  points.forEach((point, index) => {
    const value = studioHealthValue(point, metric)
    if (value === null) close()
    else segment.push(studioHealthChartPoint(index, value, plot.scaleOf(metric), plot.pointCount))
  })
  close()
  return paths.join(' ')
}

/** One window's bars, lines, and markers; the comparison's are outlined, dashed, and titled 对比. */
function StudioHealthSeriesMarks({ points, plot, comparison }: { points: readonly StudioHealthSeriesPoint[]; plot: StudioHealthPlot; comparison: boolean }) {
  const lineMetrics = plot.metrics.filter(metric => metric.mode !== 'bar')
  const barMetrics = plot.metrics.filter(metric => metric.mode === 'bar')
  const series = comparison ? 'comparison' : 'current'
  const titleOf = (point: StudioHealthSeriesPoint, metric: StudioHealthChartMetric, value: number): string =>
    `${formatStudioDashboardDateTime(point.startedAt)} · ${comparison ? '对比 ' : ''}${metric.label} ${metric.format(value)}`
  return (
    <>
      {lineMetrics.map(metric => (
        <path className={comparison ? 'health-comparison-path' : undefined} d={studioHealthLinePath(points, metric, plot)} fill="none" key={`${series}-${metric.key}`} style={{ stroke: metric.color }} />
      ))}
      {barMetrics.flatMap((metric, metricIndex) => points.map((point, index) => {
        const value = studioHealthValue(point, metric)
        if (value === null) return null
        const bar = studioHealthChartBar(index, value, plot.scaleOf(metric), plot.pointCount, metricIndex, barMetrics.length)
        return comparison
          ? <rect className="health-chart-bar health-comparison-bar" fill="none" height={bar.height} key={`${series}-bar-${metric.key}-${String(index)}`} style={{ stroke: metric.color }} width={bar.width} x={bar.x} y={bar.y}><title>{titleOf(point, metric, value)}</title></rect>
          : <rect className="health-chart-bar" height={bar.height} key={`${series}-bar-${metric.key}-${String(index)}`} style={{ fill: metric.color }} width={bar.width} x={bar.x} y={bar.y}><title>{titleOf(point, metric, value)}</title></rect>
      }))}
      {lineMetrics.flatMap(metric => points.map((point, index) => {
        const value = studioHealthValue(point, metric)
        if (value === null) return null
        const marker = studioHealthChartPoint(index, value, plot.scaleOf(metric), plot.pointCount)
        return (
          <circle className={comparison ? 'health-chart-observation health-comparison-observation' : 'health-chart-observation'} cx={marker.x} cy={marker.y} key={`${series}-marker-${metric.key}-${String(index)}`} r="3.5" style={{ fill: metric.color }}>
            <title>{titleOf(point, metric, value)}</title>
          </circle>
        )
      }))}
    </>
  )
}

function StudioHealthLaneSummary({ title, subtitle, figures }: { title: string; subtitle: string; figures: readonly StudioHealthLaneFigure[] }) {
  return (
    <aside className="health-chart-lane-summary">
      <div className="health-chart-lane-title">
        <strong>{title}</strong>
        <span>{subtitle}</span>
      </div>
      <div className="health-chart-lane-metrics">
        {figures.map(figure => (
          <div key={figure.label}>
            <span>{figure.label}</span>
            <strong>{figure.value}</strong>
            {figure.comparison !== null && <small>{figure.comparison} 较对比期</small>}
          </div>
        ))}
      </div>
    </aside>
  )
}

function StudioHealthLegend({ metrics, latest, comparing }: { metrics: readonly StudioHealthChartMetric[]; latest: StudioHealthSeriesPoint | undefined; comparing: boolean }) {
  return (
    <div className="health-chart-legend">
      {metrics.map((metric) => {
        const value = latest?.[metric.key]
        return (
          <span key={metric.key}>
            <i style={{ background: metric.color }} />{metric.label}
            <b>{typeof value === 'number' ? metric.format(value) : '—'}</b>
          </span>
        )
      })}
      {comparing && <span><i className="comparison-line" />对比区间</span>}
    </div>
  )
}

function StudioHealthScale({ metric, maxValue, secondary }: { metric: StudioHealthChartMetric | undefined; maxValue: number; secondary: boolean }) {
  const placeholder = secondary && metric === undefined ? ' health-chart-scale-placeholder' : ''
  return (
    <div className={`health-chart-scale${secondary ? ' health-chart-scale-secondary' : ''}${placeholder}`}>
      <span>{metric?.format(maxValue) ?? '—'}</span>
      <span>{metric?.format(0) ?? '—'}</span>
    </div>
  )
}

/** One lane of the performance view: its figures, legend, scales, and plot of the current window and the comparison. */
export function StudioHealthLane({ title, subtitle, metrics, figures, health }: {
  title: string
  subtitle: string
  metrics: StudioHealthChartMetric[]
  figures: readonly StudioHealthLaneFigure[]
  health: StudioDashboardHealth
}) {
  const current = health.current.series
  const comparison = health.comparison?.series ?? []
  const primary = metrics.filter(metric => metric.axis !== 'secondary')
  const secondary = metrics.filter(metric => metric.axis === 'secondary')
  const primaryMax = studioHealthMax([...current, ...comparison], primary)
  const secondaryMax = studioHealthMax([...current, ...comparison], secondary)
  const plot: StudioHealthPlot = {
    metrics,
    pointCount: Math.max(current.length, comparison.length, 1),
    scaleOf: metric => metric.axis === 'secondary' ? secondaryMax : primaryMax,
  }
  const populated = current.filter(point => point.requestCount > 0)

  return (
    <section className="health-chart-lane">
      <StudioHealthLaneSummary figures={figures} subtitle={subtitle} title={title} />
      <div className="health-chart-lane-visual">
        <StudioHealthLegend comparing={health.comparison !== undefined} latest={populated.at(-1)} metrics={metrics} />
        <div className="health-chart-wrap">
          <StudioHealthScale maxValue={primaryMax} metric={primary[0]} secondary={false} />
          <svg aria-label={title} className="health-line-chart" viewBox={`0 0 ${String(STUDIO_HEALTH_CHART_WIDTH)} ${String(STUDIO_HEALTH_CHART_HEIGHT)}`}>
            {STUDIO_HEALTH_GRID_LINES.map(position => (
              <line className="health-chart-grid-line" key={position} x1="0" x2={STUDIO_HEALTH_CHART_WIDTH} y1={position * STUDIO_HEALTH_CHART_HEIGHT} y2={position * STUDIO_HEALTH_CHART_HEIGHT} />
            ))}
            {metrics.filter(metric => metric.area === true).map(metric => (
              <path className="health-chart-area" d={studioHealthAreaPath(current, metric, plot)} key={`area-${metric.key}`} style={{ fill: metric.color }} />
            ))}
            <StudioHealthSeriesMarks comparison={false} plot={plot} points={current} />
            {health.comparison !== undefined && <StudioHealthSeriesMarks comparison plot={plot} points={comparison} />}
          </svg>
          <StudioHealthScale maxValue={secondaryMax} metric={secondary[0]} secondary />
          {populated.length === 0 && <div className="health-chart-empty">暂无运行数据</div>}
        </div>
      </div>
    </section>
  )
}

function studioHealthAxisTicks(points: readonly StudioHealthSeriesPoint[], pointCount: number): { label: string; position: string }[] {
  const step = Math.max(1, Math.ceil((points.length - 1) / 5))
  const indices = Array.from({ length: Math.ceil(points.length / step) }, (_, index) => index * step).filter(index => index < points.length)
  if (points.length > 0 && indices.at(-1) !== points.length - 1) indices.push(points.length - 1)
  const innerWidth = STUDIO_HEALTH_CHART_WIDTH - STUDIO_HEALTH_CHART_INSET_X * 2
  let previous: Date | null = null
  return indices.flatMap((index) => {
    const point = points[index]
    if (point === undefined) return []
    const date = new Date(point.startedAt)
    const crossesDate = previous === null || date.getDate() !== previous.getDate() || date.getMonth() !== previous.getMonth()
    previous = date
    const x = STUDIO_HEALTH_CHART_INSET_X + ((index + 0.5) / pointCount) * innerWidth
    return [{
      label: crossesDate ? formatStudioDashboardDateTime(point.startedAt) : formatStudioDashboardClock(point.startedAt),
      position: `${String((x / STUDIO_HEALTH_CHART_WIDTH) * 100)}%`,
    }]
  })
}

/** The time axis under the lanes, ticked at about six of the current window's buckets. */
export function StudioHealthTimeAxis({ health }: { health: StudioDashboardHealth }) {
  const points = health.current.series
  const ticks = studioHealthAxisTicks(points, Math.max(points.length, health.comparison?.series.length ?? 0, 1))
  return (
    <div aria-label="时间轴" className="health-chart-shared-axis">
      {ticks.map((tick, index) => (
        <span className={index === 0 ? 'is-first' : index === ticks.length - 1 ? 'is-last' : ''} key={`${tick.position}-${tick.label}`} style={{ left: tick.position }}>
          <i /><b>{tick.label}</b>
        </span>
      ))}
    </div>
  )
}

function studioMiniTrendPolyline(points: readonly StudioTrendPoint[]): string {
  if (points.length === 1) return `0,${String(STUDIO_MINI_TREND_HEIGHT / 2)}`
  const maxValue = Math.max(...points.map(point => point.value), 1)
  return points.map((point, index) => {
    const x = (index / (points.length - 1)) * STUDIO_MINI_TREND_WIDTH
    const y = STUDIO_MINI_TREND_HEIGHT - (point.value / maxValue) * STUDIO_MINI_TREND_HEIGHT
    return `${String(x)},${String(y)}`
  }).join(' ')
}

/** A metric card's sparkline: the trend as a line over its area. */
export function StudioMiniTrendChart({ points }: { points: readonly StudioTrendPoint[] }) {
  if (points.length === 0) return <div className="dashboard-chart-empty">No trend</div>
  const polyline = studioMiniTrendPolyline(points)
  return (
    <svg aria-hidden="true" className="mini-trend-chart" viewBox={`0 0 ${String(STUDIO_MINI_TREND_WIDTH)} ${String(STUDIO_MINI_TREND_HEIGHT)}`}>
      <polygon className="mini-trend-area" points={`${polyline} ${String(STUDIO_MINI_TREND_WIDTH)},${String(STUDIO_MINI_TREND_HEIGHT)} 0,${String(STUDIO_MINI_TREND_HEIGHT)}`} />
      <polyline className="mini-trend-line" fill="none" points={polyline} />
    </svg>
  )
}
