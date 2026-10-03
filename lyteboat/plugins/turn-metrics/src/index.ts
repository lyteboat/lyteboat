/**
 * @lyteboat/turn-metrics — the turn-metrics recorder a service mounts (serve):
 * for every turn of a session whose agent is a preset, one line of
 * {@link LyteboatTurnMetric} appended to the UTC day's file after the turn
 * ends, from the turn's outcome (`ctx.turnOutcome`) and the skills active
 * while it ran, and a heartbeat file listing the turns this process is
 * running, rewritten at each turn's start and end and every `heartbeatMs`.
 * Files are written in order through an asynchronous queue, and a failure is
 * logged and never reaches the turn. Nothing enters a model request or the
 * session log. Day files older than `retentionDays` are removed when the
 * recorder starts. The reader is `@lyteboat/turn-metrics/reader`.
 * @module @lyteboat/turn-metrics
 */

import { mkdir, readdir, rename, rm, writeFile, appendFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import z from '@deepseek-ai/schemastery'
import type { LyteboatTurnHeartbeat, LyteboatTurnMetric } from '@lyteboat/contracts'
import type {} from '@lyteboat/turn-outcome'
import { TURN_METRIC_RUNNING_DIR, turnMetricDayFile, turnMetricDayOf, turnMetricDayOfFile } from './turn-metric-files.ts'
import { TurnMetricSkills, turnMetricOf } from './turn-metric.ts'

export interface TurnMetricsRecorderConfig {
  /** Where the metrics live; default `$LYTEBOAT_HOME/run-metrics`. */
  dir?: string
  /** Day files older than this many days are removed at start. */
  retentionDays?: number
  heartbeatMs?: number
}

const DAY_MS = 86_400_000

export default class TurnMetricsRecorder {
  /** The session projections carry the active skill the recorder notes; the turn outcome, the rest of the line. */
  static inject = ['sessionProjections', 'turnOutcome']
  static Config: z<TurnMetricsRecorderConfig> = z.object({
    dir: z.string(),
    retentionDays: z.natural().default(90),
    heartbeatMs: z.natural().default(10_000),
  })

  /**
   * Record every turn of this process's sessions.
   * @param ctx - the host context: session events and projections.
   * @param recorderConfig - the validated config.
   */
  constructor(ctx: Context, recorderConfig: TurnMetricsRecorderConfig) {
    const dir = recorderConfig.dir ?? dshHomePath('run-metrics')
    const heartbeatFile = join(dir, TURN_METRIC_RUNNING_DIR, `${hostname()}-${String(process.pid)}.json`)
    const turns = new WeakMap<Session, { agentId: string; skills: TurnMetricSkills }>()
    const running = new Map<string, LyteboatTurnHeartbeat['turns'][number]>()
    let queue: Promise<void> = mkdir(join(dir, TURN_METRIC_RUNNING_DIR), { recursive: true }).then(() => pruneDays(dir, recorderConfig.retentionDays ?? 90))
    const enqueue = (label: string, write: () => Promise<void>): void => {
      queue = queue.then(write).catch((error: unknown) => {
        ctx.logger.warn(`lyteboat turn metrics: ${label} failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    }
    const beat = (): void => {
      const heartbeat: LyteboatTurnHeartbeat = { host: hostname(), pid: process.pid, heartbeatAt: Date.now(), turns: [...running.values()] }
      enqueue('the heartbeat', () => replaceFile(heartbeatFile, JSON.stringify(heartbeat)))
    }

    const observe = (session: Session, event: SessionEvent): void => {
      if (event.type === 'turn/start') {
        const agentId = session.header.agentPreset
        if (agentId === undefined) return
        turns.set(session, { agentId, skills: new TurnMetricSkills() })
        running.set(`${session.id}:${String(event.data.turn)}`, { agentId, sessionId: session.id, turn: event.data.turn, startedAt: event.time })
        beat()
        return
      }
      const turn = turns.get(session)
      if (turn === undefined) return
      if (event.type !== 'turn/end') {
        turn.skills.note(ctx.sessionProjections.stateOf(session, 'lyteboatActiveSkill')?.active)
        return
      }
      turns.delete(session)
      running.delete(`${session.id}:${String(event.data.turn)}`)
      const outcome = ctx.turnOutcome.turn(session, event.data.turn)
      if (outcome === undefined) throw new Error(`turn ${String(event.data.turn)} ended without an outcome`)
      const metric: LyteboatTurnMetric = turnMetricOf(turn.agentId, session.id, outcome, turn.skills)
      enqueue(`the metric of ${session.id} turn ${String(event.data.turn)}`, () => appendFile(turnMetricDayFile(dir, metric.startedAt), `${JSON.stringify(metric)}\n`))
      beat()
    }

    ctx.on('session/event', (session, event) => {
      try {
        observe(session, event)
      } catch (error: unknown) {
        // The recorder must never fail a turn; a fold it cannot make is lost, and said so.
        ctx.logger.warn(`lyteboat turn metrics: ${session.id}: ${error instanceof Error ? error.message : String(error)}`)
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
    }, 'lyteboat turn metrics: the heartbeat')
  }
}

/** Write a file whole through a temporary sibling, so a reader never sees half of it. */
async function replaceFile(file: string, text: string): Promise<void> {
  const temporary = `${file}.${String(process.pid)}.tmp`
  await writeFile(temporary, text)
  await rename(temporary, file)
}

async function pruneDays(dir: string, retentionDays: number): Promise<void> {
  const oldest = turnMetricDayOf(Date.now() - retentionDays * DAY_MS)
  for (const entry of await readdir(dir)) {
    const day = turnMetricDayOfFile(entry)
    if (day !== undefined && day < oldest) await rm(join(dir, entry), { force: true })
  }
}
