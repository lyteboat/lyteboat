/**
 * @lyteboat/eval-runner/records — the eval runs on disk and an agent's case
 * files, read for the Studio (`ctx.evalRecords`) without a session
 * controller: the run directories under the evals directory (each with its
 * `run.json`, read through the contract's schema, when it has one), one run
 * with its results, the checks that differ between two runs, the case files
 * of an agent directory one by one (a file that does not load says why, so
 * one bad file does not hide the others), and removing a run. A run is named
 * by its id, the directory's name; an id that is not one path segment names
 * no run.
 * @module @lyteboat/eval-runner/records
 */

import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import z from '@deepseek-ai/schemastery'
import { LYTEBOAT_EVAL_RUN_ID_PATTERN, lyteboatEvalRunRecordSchema } from '@lyteboat/contracts'
import { evalCaseFilesOf, readEvalCaseFile, type EvalCase } from './eval-case.ts'
import { compareEvalResults, evalRunRecordFile, evalRunResultsFile, readEvalResults, type EvalChange, type EvalRunRecord, type EvalTurnResult } from './eval-report.ts'

export type { EvalCase } from './eval-case.ts'
export type { EvalChange, EvalRunRecord, EvalTurnResult } from './eval-report.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    evalRecords: EvalRecordsService
  }
}

export interface Config {
  /** Where the runs live; default `$LYTEBOAT_HOME/evals`, where `lyteboat eval` writes them. */
  dir?: string
}

export const Config: z<Config> = z.object({
  dir: z.string(),
})

/** One run directory. */
export interface EvalRunListing {
  runId: string
  dir: string
  /** Its `run.json`; absent while the run is running, or when it stopped or broke before writing one. */
  record?: EvalRunRecord
  /** The directory's modification time, epoch ms. */
  modifiedAt: number
}

/** One case file of an agent. */
export interface EvalCaseFileListing {
  /** Absolute. */
  file: string
  cases: EvalCase[]
  /** Why the file does not load, or which of its ids an earlier file already holds. */
  error?: string
}

/** Host service: the eval runs on disk and an agent's case files. */
export class EvalRecordsService extends Service {
  static Config = Config
  private readonly dir: string
  private readonly records = new Map<string, { mtimeMs: number; size: number; record: EvalRunRecord | undefined }>()

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'evalRecords')
    this.dir = config.dir ?? dshHomePath('evals')
  }

  /** Every run directory, in no particular order. */
  runs(): EvalRunListing[] {
    // Before the first run there is no directory, and no run.
    if (!existsSync(this.dir)) return []
    return readdirSync(this.dir, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && LYTEBOAT_EVAL_RUN_ID_PATTERN.test(entry.name))
      .map(entry => this.listing(entry.name))
  }

  /**
   * One run with its results (none until `results.jsonl` is written).
   * @returns undefined when the id names no run directory.
   */
  run(runId: string): (EvalRunListing & { results: EvalTurnResult[] }) | undefined {
    const dir = this.runDir(runId)
    if (dir === undefined) return undefined
    const listing = this.listing(runId)
    return { ...listing, results: existsSync(evalRunResultsFile(dir)) ? readEvalResults(dir) : [] }
  }

  /**
   * The checks whose results differ between two runs, in the later run's order.
   * @throws when either run has no results.
   */
  compare(before: string, after: string): EvalChange[] {
    const results = (runId: string): EvalTurnResult[] => {
      const dir = this.runDir(runId)
      if (dir === undefined) throw new Error(`eval-runner: no eval run ${runId}`)
      return readEvalResults(dir)
    }
    return compareEvalResults(results(before), results(after))
  }

  /** The case files of an agent directory's `evals/`, in name order; none when it has no `evals/`. */
  cases(agentDir: string): EvalCaseFileListing[] {
    const evalsDir = join(agentDir, 'evals')
    if (!existsSync(evalsDir)) return []
    const seen = new Set<string>()
    return evalCaseFilesOf(evalsDir).map((file) => {
      let cases: EvalCase[]
      try {
        cases = readEvalCaseFile(file)
      } catch (error: unknown) {
        return { file, cases: [], error: error instanceof Error ? error.message : String(error) }
      }
      const repeated = cases.filter(evalCase => seen.has(evalCase.id)).map(evalCase => evalCase.id)
      for (const evalCase of cases) seen.add(evalCase.id)
      return { file, cases, ...repeated.length === 0 ? {} : { error: `eval-runner: ${file}: case ${repeated.map(id => JSON.stringify(id)).join(', ')} is in an earlier file too` } }
    })
  }

  /** @returns whether a run directory was removed. */
  remove(runId: string): boolean {
    const dir = this.runDir(runId)
    if (dir === undefined) return false
    rmSync(dir, { recursive: true, force: true })
    this.records.delete(runId)
    return true
  }

  private runDir(runId: string): string | undefined {
    if (!LYTEBOAT_EVAL_RUN_ID_PATTERN.test(runId)) return undefined
    const dir = join(this.dir, runId)
    return existsSync(dir) && statSync(dir).isDirectory() ? dir : undefined
  }

  private listing(runId: string): EvalRunListing {
    const dir = join(this.dir, runId)
    const record = this.record(runId, evalRunRecordFile(dir))
    return { runId, dir, ...record === undefined ? {} : { record }, modifiedAt: Math.round(statSync(dir).mtimeMs) }
  }

  /** A run's `run.json`, reread only when it changes; one the schema refuses (an older format) is none. */
  private record(runId: string, file: string): EvalRunRecord | undefined {
    if (!existsSync(file)) return undefined
    const { mtimeMs, size } = statSync(file)
    const cached = this.records.get(runId)
    if (cached !== undefined && cached.mtimeMs === mtimeMs && cached.size === size) return cached.record
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      // A run.json cut short reads as none, as a run that has not written one yet.
      raw = undefined
    }
    const parsed = lyteboatEvalRunRecordSchema.safeParse(raw)
    if (!parsed.success) this.ctx.logger.warn(`lyteboat eval records: ${file} is not a run record this build reads; the run is listed without it`)
    const record = parsed.success ? parsed.data : undefined
    this.records.set(runId, { mtimeMs, size, record })
    return record
  }
}

export default EvalRecordsService
