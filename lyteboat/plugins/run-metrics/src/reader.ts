/**
 * @lyteboat/run-metrics/reader — the run metrics a service's recorder wrote,
 * read for the Studio (`ctx.runMetricsReader`): the turns that started in a
 * time range, of one agent or all, and the turns running now, from the
 * heartbeat files written in the last 30 seconds. A day file's parsed lines
 * are cached until its size or modification time changes; a line that does
 * not parse is skipped and logged once per file state.
 * @module @lyteboat/run-metrics/reader
 */

import { existsSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import z from '@deepseek-ai/schemastery'
import { lyteboatRunHeartbeatSchema, lyteboatRunMetricSchema, type LyteboatRunHeartbeat, type LyteboatRunMetric } from '@lyteboat/contracts'
import { RUN_METRIC_RUNNING_DIR, runMetricDaysBetween } from './run-metric-files.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    runMetricsReader: RunMetricsReaderService
  }
}

/** A heartbeat older than this is a process that is gone. */
export const RUN_HEARTBEAT_STALE_MS = 30_000

/** One turn running now, with the process running it. */
export type RunningTurn = LyteboatRunHeartbeat['turns'][number] & { host: string; pid: number }

export interface Config {
  /** Where the metrics live; default `$LYTEBOAT_HOME/run-metrics`. */
  dir?: string
}

export const Config: z<Config> = z.object({
  dir: z.string(),
})

/** Host service: the recorded run metrics and the running turns. */
export class RunMetricsReaderService extends Service {
  // The loader applies a class plugin's static Config, not the module's.
  static Config = Config
  private readonly dir: string
  private readonly days = new Map<string, { size: number; mtimeMs: number; rows: LyteboatRunMetric[] }>()

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'runMetricsReader')
    this.dir = config.dir ?? dshHomePath('run-metrics')
  }

  /**
   * The turns that started from `from` to `to` (epoch ms, both included), in file order.
   * @param agentId - only this agent's turns; all agents' when absent.
   */
  async records(from: number, to: number, agentId?: string): Promise<LyteboatRunMetric[]> {
    const rows: LyteboatRunMetric[] = []
    for (const day of runMetricDaysBetween(from, to)) {
      for (const row of await this.day(day)) {
        if (row.startedAt >= from && row.startedAt <= to && (agentId === undefined || row.agentId === agentId)) rows.push(row)
      }
    }
    return rows
  }

  /** The turns running now, from the heartbeats written in the last {@link RUN_HEARTBEAT_STALE_MS}. */
  async running(now = Date.now()): Promise<RunningTurn[]> {
    const dir = join(this.dir, RUN_METRIC_RUNNING_DIR)
    // Before serve's first start there is no directory, and nothing runs.
    if (!existsSync(dir)) return []
    const turns: RunningTurn[] = []
    for (const entry of (await readdir(dir)).filter(candidate => candidate.endsWith('.json'))) {
      const parsed = lyteboatRunHeartbeatSchema.safeParse(await this.json(join(dir, entry)))
      if (!parsed.success || now - parsed.data.heartbeatAt > RUN_HEARTBEAT_STALE_MS) continue
      const { host, pid } = parsed.data
      turns.push(...parsed.data.turns.map(turn => ({ ...turn, host, pid })))
    }
    return turns
  }

  private async json(file: string): Promise<unknown> {
    try {
      return JSON.parse(await readFile(file, 'utf8')) as unknown
    } catch {
      // A heartbeat removed or replaced while listed reads as none; the next poll sees the new one.
      return undefined
    }
  }

  private async day(day: string): Promise<LyteboatRunMetric[]> {
    const file = join(this.dir, `${day}.jsonl`)
    // A day without turns has no file.
    if (!existsSync(file)) return []
    const info = await stat(file)
    const cached = this.days.get(day)
    if (cached !== undefined && cached.size === info.size && cached.mtimeMs === info.mtimeMs) return cached.rows
    const rows: LyteboatRunMetric[] = []
    let skipped = 0
    for (const line of (await readFile(file, 'utf8')).split('\n')) {
      if (line.trim() === '') continue
      let parsed: ReturnType<typeof lyteboatRunMetricSchema.safeParse>
      try {
        parsed = lyteboatRunMetricSchema.safeParse(JSON.parse(line))
      } catch {
        // A line cut short by a crash mid-append: skipped and counted below.
        skipped++
        continue
      }
      if (parsed.success) rows.push(parsed.data)
      else skipped++
    }
    if (skipped > 0) this.ctx.logger.warn(`lyteboat run metrics reader: ${file}: ${String(skipped)} line(s) are not run metrics and were skipped`)
    this.days.set(day, { size: info.size, mtimeMs: info.mtimeMs, rows })
    return rows
  }
}

export default RunMetricsReaderService
