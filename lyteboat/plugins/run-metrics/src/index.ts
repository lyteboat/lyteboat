/**
 * @lyteboat/run-metrics — the run-metrics recorder a service mounts (serve):
 * for every turn of a session whose agent is a preset, one line of
 * {@link LyteboatRunMetric} appended to the UTC day's file after the turn
 * ends, and a heartbeat file listing the turns this process is running,
 * rewritten at each turn's start and end and every `heartbeatMs`. The
 * listener only folds in memory; files are written in order through an
 * asynchronous queue, and a failure is logged and never reaches the turn.
 * Nothing enters a model request or the session log. Day files older than
 * `retentionDays` are removed when the recorder starts. The reader is
 * `@lyteboat/run-metrics/reader`.
 * @module @lyteboat/run-metrics
 */

import { mkdir, readdir, rename, rm, writeFile, appendFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import z from '@deepseek-ai/schemastery'
import type { LyteboatRunHeartbeat, LyteboatRunMetric } from '@lyteboat/contracts'
import { RUN_METRIC_RUNNING_DIR, runMetricDayFile, runMetricDayOf, runMetricDayOfFile } from './run-metric-files.ts'
import { RunMetricTurn } from './run-metric-turn.ts'

export interface RunMetricsRecorderConfig {
  /** Where the metrics live; default `$LYTEBOAT_HOME/run-metrics`. */
  dir?: string
  /** Day files older than this many days are removed at start. */
  retentionDays?: number
  heartbeatMs?: number
}

const DAY_MS = 86_400_000

export default class RunMetricsRecorder {
  /** The session projections carry the active skill the recorder notes. */
  static inject = ['sessionProjections']
  static Config: z<RunMetricsRecorderConfig> = z.object({
    dir: z.string(),
    retentionDays: z.natural().default(90),
    heartbeatMs: z.natural().default(10_000),
  })

  /**
   * Record every turn of this process's sessions.
   * @param ctx - the host context: session events and projections.
   * @param recorderConfig - the validated config.
   */
  constructor(ctx: Context, recorderConfig: RunMetricsRecorderConfig) {
    const dir = recorderConfig.dir ?? dshHomePath('run-metrics')
    const heartbeatFile = join(dir, RUN_METRIC_RUNNING_DIR, `${hostname()}-${String(process.pid)}.json`)
    const turns = new WeakMap<Session, RunMetricTurn>()
    const running = new Map<string, LyteboatRunHeartbeat['turns'][number]>()
    let queue: Promise<void> = mkdir(join(dir, RUN_METRIC_RUNNING_DIR), { recursive: true }).then(() => pruneDays(dir, recorderConfig.retentionDays ?? 90))
    const enqueue = (label: string, write: () => Promise<void>): void => {
      queue = queue.then(write).catch((error: unknown) => {
        ctx.logger.warn(`lyteboat run metrics: ${label} failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    }
    const beat = (): void => {
      const heartbeat: LyteboatRunHeartbeat = { host: hostname(), pid: process.pid, heartbeatAt: Date.now(), turns: [...running.values()] }
      enqueue('the heartbeat', () => replaceFile(heartbeatFile, JSON.stringify(heartbeat)))
    }

    const observe = (session: Session, event: SessionEvent): void => {
      if (event.type === 'turn/start') {
        const agentId = session.header.agentPreset
        if (agentId === undefined) return
        turns.set(session, new RunMetricTurn(agentId, session.id, event.data.turn, event.time))
        running.set(`${session.id}:${String(event.data.turn)}`, { agentId, sessionId: session.id, turn: event.data.turn, startedAt: event.time })
        beat()
        return
      }
      const turn = turns.get(session)
      if (turn === undefined) return
      if (event.type !== 'turn/end') {
        turn.add(event)
        turn.noteActiveSkill(ctx.sessionProjections.stateOf(session, 'lyteboatActiveSkill')?.active)
        return
      }
      turns.delete(session)
      running.delete(`${session.id}:${String(event.data.turn)}`)
      const metric: LyteboatRunMetric = turn.ended(event)
      enqueue(`the metric of ${session.id} turn ${String(event.data.turn)}`, () => appendFile(runMetricDayFile(dir, metric.startedAt), `${JSON.stringify(metric)}\n`))
      beat()
    }

    ctx.on('session/event', (session, event) => {
      try {
        observe(session, event)
      } catch (error: unknown) {
        // The recorder must never fail a turn; a fold it cannot make is lost, and said so.
        ctx.logger.warn(`lyteboat run metrics: ${session.id}: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
    ctx.effect(() => {
      beat()
      const timer = setInterval(beat, recorderConfig.heartbeatMs ?? 10_000)
      timer.unref()
      return async () => {
        clearInterval(timer)
        running.clear()
        enqueue('removing the heartbeat', () => rm(heartbeatFile, { force: true }))
        await queue
      }
    }, 'lyteboat run metrics: the heartbeat')
  }
}

/** Write a file whole through a temporary sibling, so a reader never sees half of it. */
async function replaceFile(file: string, text: string): Promise<void> {
  const temporary = `${file}.${String(process.pid)}.tmp`
  await writeFile(temporary, text)
  await rename(temporary, file)
}

async function pruneDays(dir: string, retentionDays: number): Promise<void> {
  const oldest = runMetricDayOf(Date.now() - retentionDays * DAY_MS)
  for (const entry of await readdir(dir)) {
    const day = runMetricDayOfFile(entry)
    if (day !== undefined && day < oldest) await rm(join(dir, entry), { force: true })
  }
}
