/**
 * Where turn metrics live under their directory (by default
 * `$LYTEBOAT_HOME/run-metrics`): one JSONL file per UTC day of the turns'
 * starts, `<YYYY-MM-DD>.jsonl`, and one heartbeat file per running process,
 * `running/<host>-<pid>.json`. The recorder writes them; the reader reads them.
 * @module @lyteboat/turn-metrics/turn-metric-files
 */

import { join } from 'node:path'

/** The heartbeat files' subdirectory. */
export const TURN_METRIC_RUNNING_DIR = 'running'

const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/u
const DAY_MS = 86_400_000

/** The UTC day of a time, `YYYY-MM-DD`. */
export function turnMetricDayOf(time: number): string {
  return new Date(time).toISOString().slice(0, 10)
}

/** The day file a turn that started at `time` is appended to. */
export function turnMetricDayFile(dir: string, time: number): string {
  return join(dir, `${turnMetricDayOf(time)}.jsonl`)
}

/** The day a file name holds, or undefined for a file that is not a day file. */
export function turnMetricDayOfFile(name: string): string | undefined {
  return DAY_FILE.exec(name)?.[1]
}

/** The day files that hold turns started from `from` to `to`, in order. */
export function turnMetricDaysBetween(from: number, to: number): string[] {
  const days: string[] = []
  for (let day = Math.floor(from / DAY_MS) * DAY_MS; day <= to; day += DAY_MS) days.push(turnMetricDayOf(day))
  return days
}
