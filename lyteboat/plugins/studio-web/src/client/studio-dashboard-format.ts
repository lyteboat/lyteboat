/**
 * How the Dashboard says its figures, the way the original Studio's Dashboard
 * says them: counts in zh-CN's compact notation; durations in ms under a
 * second, in seconds above; ratios to two decimals under ten; moments as
 * `MM/DD HH:mm` or `HH:mm` in local time. The date inputs' `YYYY-MM-DD`
 * values become the bounds of that local day.
 * @module @lyteboat/studio-web/client/studio-dashboard-format
 */

const STUDIO_DASHBOARD_DATE_TIME = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
})
const STUDIO_DASHBOARD_CLOCK = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit', minute: '2-digit', hour12: false,
})
const STUDIO_DASHBOARD_COUNT = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 })
const STUDIO_DASHBOARD_COUNT_COMPACT = new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 })
const STUDIO_DASHBOARD_DAY_MS = 86_400_000

/** A count: `987`, `5678`, `1.2万`; zh-CN's compact notation starts at 万, so four digits stay whole. */
export function formatStudioDashboardCount(value: number): string {
  return (value >= 1000 ? STUDIO_DASHBOARD_COUNT_COMPACT : STUDIO_DASHBOARD_COUNT).format(value)
}

/** A duration: `420 ms`, `1.25 s`, `12.5 s`; `—` for none. */
export function formatStudioDashboardDuration(value: number | null): string {
  if (value === null) return '—'
  if (Math.abs(value) < 1000) return `${String(Math.round(value))} ms`
  return `${(value / 1000).toFixed(Math.abs(value) < 10_000 ? 2 : 1)} s`
}

/** A ratio: `1.50`, `12.3`. */
export function formatStudioDashboardRatio(value: number): string {
  return Number.isFinite(value) ? value.toFixed(Math.abs(value) < 10 ? 2 : 1) : '0'
}

/** A moment with its date: `09/26 14:30`. */
export function formatStudioDashboardDateTime(epochMs: number): string {
  return STUDIO_DASHBOARD_DATE_TIME.format(new Date(epochMs))
}

/** A moment's time of day: `14:30`. */
export function formatStudioDashboardClock(epochMs: number): string {
  return STUDIO_DASHBOARD_CLOCK.format(new Date(epochMs))
}

/** The local day `daysBack` days before now, as a date input holds it: `2026-09-26`. */
export function studioDashboardDateInput(daysBack: number): string {
  const date = new Date(Date.now() - daysBack * STUDIO_DASHBOARD_DAY_MS)
  return `${String(date.getFullYear())}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/** The start (epoch ms) of a date input's local day. */
export function studioDashboardDayStart(value: string): number {
  return new Date(`${value}T00:00:00`).getTime()
}

/** The end (epoch ms, exclusive) of a date input's local day: the next local midnight, which is not 24 hours on when the clock changes that day. */
export function studioDashboardDayEnd(value: string): number {
  const date = new Date(`${value}T00:00:00`)
  date.setDate(date.getDate() + 1)
  return date.getTime()
}
