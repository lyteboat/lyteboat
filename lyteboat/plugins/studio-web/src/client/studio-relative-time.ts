/**
 * How long ago a moment was, said the way the original Studio says it on its
 * cards and chips: just now, then minutes, hours, or days; the Dashboard's
 * activity feed says the age without the `ago`.
 * @module @lyteboat/studio-web/client/studio-relative-time
 */

/**
 * @param epochMs - the moment, in milliseconds since the epoch.
 * @param options - `ago: false` leaves the `ago` out (`12m`), as the Dashboard's activity feed does.
 * @returns `just now`, `12m ago`, `3h ago`, or `2d ago`.
 */
export function formatStudioRelativeTime(epochMs: number, { ago = true }: { ago?: boolean } = {}): string {
  const minutes = Math.floor((Date.now() - epochMs) / 60_000)
  if (minutes < 1) return 'just now'
  const suffix = ago ? ' ago' : ''
  if (minutes < 60) return `${String(minutes)}m${suffix}`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${String(hours)}h${suffix}`
  return `${String(Math.floor(hours / 24))}d${suffix}`
}
