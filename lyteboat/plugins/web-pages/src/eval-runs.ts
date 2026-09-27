/**
 * The eval runs the Evals page shows: the run directories under the evals directory
 * (`$LYTEBOAT_HOME/evals`), newest first, each with its `run.json` summary,
 * and one run's `report.md`. A directory without `run.json` is not a run; one
 * whose `run.json` the contract's schema refuses (a run recorded before the
 * agent identity) is left out with a warning.
 * @module @lyteboat/web-pages/eval-runs
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { LYTEBOAT_EVAL_RUN_ID_PATTERN, lyteboatEvalRunRecordSchema } from '@lyteboat/contracts'
import type { WebPagesEvalRun } from './web-pages-endpoints.ts'

/**
 * The runs in `evalsDir`, newest first.
 * @param evalsDir - the evals directory; absent: no runs.
 * @param warn - told about each run whose `run.json` cannot be read.
 */
export function listEvalRuns(evalsDir: string, warn: (message: string) => void): WebPagesEvalRun[] {
  if (!existsSync(evalsDir)) return []
  const runs: WebPagesEvalRun[] = []
  for (const id of readdirSync(evalsDir)) {
    const file = join(evalsDir, id, 'run.json')
    if (!LYTEBOAT_EVAL_RUN_ID_PATTERN.test(id) || !existsSync(file)) continue
    const parsed = lyteboatEvalRunRecordSchema.safeParse(readJson(file))
    if (!parsed.success) {
      warn(`web-pages: eval run ${id} left out: ${file} is not a run.json this lyteboat reads (${parsed.error.issues[0]?.message ?? 'invalid'})`)
      continue
    }
    const run = parsed.data
    runs.push({ id, agent: run.agent.id, mode: run.mode, cases: run.cases.length, passedCases: run.cases.filter(evalCase => evalCase.pass).length, startedAt: run.startedAt })
  }
  return runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt))
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    // A torn or foreign file reads as invalid, which the caller reports.
    return undefined
  }
}

/**
 * One run's report.
 * @throws when the id is not a run's directory name, or the run has no report.
 */
export function readEvalReport(evalsDir: string, id: string): string {
  const file = join(evalsDir, id, 'report.md')
  if (!LYTEBOAT_EVAL_RUN_ID_PATTERN.test(id) || !existsSync(file)) throw new Error(`no eval run ${JSON.stringify(id)}`)
  return readFileSync(file, 'utf8')
}
