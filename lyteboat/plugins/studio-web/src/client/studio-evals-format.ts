/**
 * How the Evals pages say a run's facts, the way the original Studio's Evals
 * surface says them: a pass rate as the share of cases passed, toned ok from
 * 90 %, warn from 70 %, err below; a duration in seconds, or minutes and
 * seconds past one minute; `passed/total` figures; the turns a multi-turn
 * case passed; an agent digest cut to its first eight hex digits; a model as
 * `provider/model`.
 * @module @lyteboat/studio-web/client/studio-evals-format
 */

import type { LyteboatAgentModel } from '@lyteboat/contracts'
import type { StudioEvalRun } from '@lyteboat/contracts/studio'

/** A score's colour. */
export type StudioEvalsTone = 'ok' | 'warn' | 'err'

/**
 * A written run's case results; none for a run that has not written them (it
 * runs, or ended before it could), whose case figures are only its progress.
 */
export function studioEvalCaseResults(run: StudioEvalRun): StudioEvalRun['cases'] | undefined {
  return run.turns === undefined ? undefined : run.cases
}

/** A run with results to compare or replay: one that finished passed or failed. */
export function studioEvalRunWritten(run: StudioEvalRun): boolean {
  return run.status === 'passed' || run.status === 'failed'
}

/** The share of a written run's cases that passed; null for a run without results or cases. */
export function studioEvalPassRate(run: StudioEvalRun): number | null {
  const total = studioEvalCaseResults(run)?.total
  return total === undefined || total === 0 ? null : run.cases.passed / total
}

/** A pass rate's tone. */
export function studioEvalTone(rate: number): StudioEvalsTone {
  if (rate >= 0.9) return 'ok'
  return rate >= 0.7 ? 'warn' : 'err'
}

/** `83%`, or `83.3%` with one digit; `—` for none. */
export function formatStudioEvalPercent(rate: number | null, digits = 0): string {
  return rate === null ? '—' : `${(rate * 100).toFixed(digits)}%`
}

/** `12.4s`, `2m 5s`; `—` for none. */
export function formatStudioEvalDuration(ms: number | undefined): string {
  if (ms === undefined || ms <= 0) return '—'
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds % 60)
  return rest > 0 ? `${String(minutes)}m ${String(rest)}s` : `${String(minutes)}m`
}

/** `5/6`; `—` while the total is unknown. */
export function formatStudioEvalFraction(figures: { total?: number; passed: number } | undefined): string {
  return figures?.total === undefined ? '—' : `${String(figures.passed)}/${String(figures.total)}`
}

/** How many of a multi-turn case's turns passed, as its verdict says it: ` · 2/3`; nothing for a single turn. */
export function formatStudioEvalTurnsPassed(passedTurns: number, turnCount: number): string {
  return turnCount > 1 ? ` · ${String(passedTurns)}/${String(turnCount)}` : ''
}

/** `sha256:0123…` → `01234567`. */
export function studioEvalShortDigest(digest: string): string {
  return digest.replace(/^sha256:/u, '').slice(0, 8)
}

/** `deepseek/deepseek-chat`, with the reasoning effort after a dot when set; `—` for none (a replay sends no request). */
export function studioEvalModelLabel(model: LyteboatAgentModel | undefined): string {
  if (model === undefined) return '—'
  return `${model.provider}/${model.model}${model.reasoningEffort === undefined ? '' : ` · ${model.reasoningEffort}`}`
}
