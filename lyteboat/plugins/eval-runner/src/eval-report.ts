/**
 * An eval run on disk: `run.json` (what ran and how it went), `results.jsonl`
 * (one line per turn: what it showed and each check; no timings, so one
 * recording replays into the same lines), `sessions/<case>/` (the recorded
 * sessions of a real run), and `report.md`. Two runs compare turn by turn and
 * check by check; a check that passed before and fails now is a regression.
 * @module @lyteboat/eval-runner/eval-report
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SESSION_FORMAT_VERSION, SessionLogOffset, type SessionHeader } from '@deepseek-ai/dsh-session'
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'
import type { LyteboatEvalRunRecord } from '@lyteboat/contracts'
import type { EvalCheck, EvalObservation } from './eval-check.ts'

/** One turn's result, as a `results.jsonl` line. */
export interface EvalTurnResult {
  case: string
  /** 1-based, within the case. */
  turn: number
  message: string
  observed: EvalObservation
  checks: EvalCheck[]
  pass: boolean
}

/** What ran and how it went, as `run.json` (the contract's shape, read back through its schema). */
export type EvalRunRecord = LyteboatEvalRunRecord

/** A check whose result differs between two runs. */
export interface EvalChange {
  case: string
  turn: number
  check: string
  before: 'pass' | 'fail' | 'absent'
  after: 'pass' | 'fail' | 'absent'
}

/** A run directory's summary, `run.json`. */
export function evalRunRecordFile(runDir: string): string {
  return join(runDir, 'run.json')
}

/** A run directory's per-turn results, `results.jsonl`: one JSON line per turn. */
export function evalRunResultsFile(runDir: string): string {
  return join(runDir, 'results.jsonl')
}

/** Where a case's recorded session lives in a run directory. */
export function recordedSessionFile(runDir: string, caseId: string): string {
  return join(runDir, 'sessions', caseId, `session.v${String(SESSION_FORMAT_VERSION)}.jsonl`)
}

/**
 * Write a session as a JSONL recording dsh's replay reads: the physical header
 * line as dsh's persistence encodes it, then every event.
 * @param file - the recording's path; its directory is created.
 * @param session - the session's header, its inherited prefix length, and its events in log order.
 */
export function writeRecordedSession(file: string, session: { meta: SessionHeader; inheritedEventCount: number; events: readonly unknown[] }): void {
  const header = sessionFormatCatalog.encodeCurrentHeader({ ...session.meta, delegationDepth: session.meta.delegationDepth ?? 0 }, SessionLogOffset(session.inheritedEventCount))
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, [header, ...session.events].map(line => JSON.stringify(line)).join('\n') + '\n')
}

const verdict = (pass: boolean): string => (pass ? '✓' : '✗')

/** The run as Markdown: the summary, one row per turn, and why each failed check failed. */
export function renderEvalReport(run: EvalRunRecord, results: readonly EvalTurnResult[]): string {
  const passedCases = run.cases.filter(evalCase => evalCase.pass).length
  const lines = [
    `# Eval ${run.agent.id}: ${String(passedCases)}/${String(run.cases.length)} cases passed`,
    '',
    `- mode: ${run.mode}${run.from === undefined ? '' : ` (from ${run.from})`}`,
    `- turns: ${String(run.turns.passed)}/${String(run.turns.total)} passed; checks: ${String(run.checks.passed)}/${String(run.checks.total)} passed`,
    `- started ${run.startedAt}, took ${String(Math.round(run.durationMs / 1000))}s`,
    '',
    '| case | turn | message | result | failed checks |',
    '|---|---|---|---|---|',
    ...results.map(result => `| ${result.case} | ${String(result.turn)} | ${result.message.replaceAll('|', '\\|')} | ${verdict(result.pass)} | ${result.checks.filter(check => !check.pass).map(check => check.check).join(', ')} |`),
  ]
  const failed = results.filter(result => !result.pass)
  if (failed.length > 0) {
    lines.push('', '## Failed checks')
    for (const result of failed) {
      lines.push('', `### ${result.case}, turn ${String(result.turn)}: ${result.message}`, '')
      for (const check of result.checks.filter(item => !item.pass)) {
        lines.push(`- \`${check.check}\`: expected ${JSON.stringify(check.expected)}, got ${JSON.stringify(check.actual)}`)
      }
    }
  }
  return lines.join('\n') + '\n'
}

/** Write `run.json`, `results.jsonl`, and `report.md` into the run directory. */
export function writeEvalRun(runDir: string, run: EvalRunRecord, results: readonly EvalTurnResult[]): void {
  mkdirSync(runDir, { recursive: true })
  writeFileSync(evalRunRecordFile(runDir), JSON.stringify(run, null, 2) + '\n')
  writeFileSync(evalRunResultsFile(runDir), results.map(result => JSON.stringify(result)).join('\n') + '\n')
  writeFileSync(join(runDir, 'report.md'), renderEvalReport(run, results))
}

/**
 * Read a run's results.
 * @throws when the directory holds no `results.jsonl`.
 */
export function readEvalResults(runDir: string): EvalTurnResult[] {
  const file = evalRunResultsFile(runDir)
  if (!existsSync(file)) throw new Error(`eval-runner: no results.jsonl in ${runDir}`)
  // The file is this module's own output.
  return readFileSync(file, 'utf8').split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line) as EvalTurnResult)
}

/**
 * The checks whose results differ between two runs, in the order of the later run.
 * @param before - the earlier run's results.
 * @param after - the later run's results.
 */
export function compareEvalResults(before: readonly EvalTurnResult[], after: readonly EvalTurnResult[]): EvalChange[] {
  const key = (evalCase: string, turn: number, check: string): string => `${evalCase}\0${String(turn)}\0${check}`
  const state = (results: readonly EvalTurnResult[]): Map<string, 'pass' | 'fail'> => new Map(results.flatMap(result => result.checks.map(check => [key(result.case, result.turn, check.check), check.pass ? 'pass' : 'fail'] as const)))
  const was = state(before)
  const now = state(after)
  const changes: EvalChange[] = []
  const seen = new Set<string>()
  for (const result of [...after, ...before]) {
    for (const check of result.checks) {
      const id = key(result.case, result.turn, check.check)
      if (seen.has(id)) continue
      seen.add(id)
      const from = was.get(id) ?? 'absent'
      const to = now.get(id) ?? 'absent'
      if (from !== to) changes.push({ case: result.case, turn: result.turn, check: check.check, before: from, after: to })
    }
  }
  return changes
}
