/**
 * An agent's eval cases: YAML files whose `cases` each open a new session and
 * send its turns in order, with what each turn must show. The files are read
 * strictly: an unknown key, a blank message, an id that is not kebab-case or
 * repeats across the files, a regular expression that does not compile, or a
 * path that is neither a file nor a directory fails the load, naming the file.
 * @module @lyteboat/eval-runner/eval-case
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'
import { load } from 'js-yaml'
import { z } from 'zod'
import { LYTEBOAT_EVAL_CASE_ID_PATTERN, LYTEBOAT_TURN_OUTCOMES, type JsonValue, type LyteboatTurnOutcome } from '@lyteboat/contracts'

/** What one turn must show; a check that is absent is not made. */
export interface EvalExpect {
  /** The active skill after the turn; null: none. */
  skill?: string | null
  tools?: { called?: string[]; not_called?: string[] }
  /** The cards the turn shows, by area in any order, and how many. */
  cards?: { areas?: string[]; count?: number }
  outcome?: LyteboatTurnOutcome
  /** The answer text. */
  text?: { includes?: string[]; excludes?: string[]; matches?: string }
  /** How many model calls the loop made in the turn. */
  model_requests?: { min?: number; max?: number }
}

/** One message of a case. */
export interface EvalTurn {
  message: string
  /** The request context this message carries; the session keeps the latest. */
  context?: { [key: string]: JsonValue }
  expect: EvalExpect
}

/** One case: a new session and its turns. */
export interface EvalCase {
  /** Kebab-case; names the case's recorded session. */
  id: string
  /** The first turn's request context, unless the turn brings its own. */
  context?: { [key: string]: JsonValue }
  turns: EvalTurn[]
}

const names = z.array(z.string().min(1))
const jsonObject = z.record(z.string(), z.json())

const expectSchema = z.strictObject({
  skill: z.string().min(1).nullable().optional(),
  tools: z.strictObject({ called: names.optional(), not_called: names.optional() }).optional(),
  cards: z.strictObject({ areas: names.optional(), count: z.number().int().nonnegative().optional() }).optional(),
  outcome: z.enum(LYTEBOAT_TURN_OUTCOMES).optional(),
  text: z.strictObject({
    includes: names.optional(),
    excludes: names.optional(),
    matches: z.string().min(1).refine((pattern: string) => compiles(pattern), 'is not a regular expression').optional(),
  }).optional(),
  model_requests: z.strictObject({ min: z.number().int().nonnegative().optional(), max: z.number().int().nonnegative().optional() }).optional(),
})

const caseFileSchema = z.strictObject({
  cases: z.array(z.strictObject({
    id: z.string().regex(LYTEBOAT_EVAL_CASE_ID_PATTERN, 'must be kebab-case'),
    context: jsonObject.optional(),
    turns: z.array(z.strictObject({
      message: z.string().refine((text: string) => text.trim() !== '', 'must not be blank'),
      context: jsonObject.optional(),
      expect: expectSchema.default({}),
    })).min(1),
  })).min(1),
})

function compiles(pattern: string): boolean {
  try {
    return new RegExp(pattern, 'u') instanceof RegExp
  } catch {
    // The refinement reports it; the error itself says nothing more useful.
    return false
  }
}

/** The case files a path names: the file itself, or a directory's `.yml` / `.yaml` files in name order. */
export function evalCaseFilesOf(path: string): string[] {
  let isDirectory: boolean
  try {
    isDirectory = statSync(path).isDirectory()
  } catch (error: unknown) {
    throw new Error(`eval-runner: no case file or directory at ${path}`, { cause: error })
  }
  if (!isDirectory) return [path]
  return readdirSync(path).filter(name => ['.yml', '.yaml'].includes(extname(name))).sort().map(name => join(path, name))
}

/**
 * Read one case file.
 * @throws when it cannot be read or fails the schema, naming the file.
 */
export function readEvalCaseFile(file: string): EvalCase[] {
  let raw: unknown
  try {
    raw = load(readFileSync(file, 'utf8'))
  } catch (error: unknown) {
    throw new Error(`eval-runner: cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
  const parsed = caseFileSchema.safeParse(raw)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new Error(`eval-runner: ${file}: ${issue === undefined ? 'invalid' : `${issue.path.join('.')}: ${issue.message}`}`)
  }
  // zod's JSON type is the same lossless JSON contracts names; the cast only renames it.
  return parsed.data.cases as EvalCase[]
}

/**
 * Read the cases the paths name, in path order.
 * @param paths - case files, or directories of them.
 * @returns every case, ids unique.
 * @throws when a path is missing, a file is invalid, no case is found, or an id repeats.
 */
export function loadEvalCases(paths: readonly string[]): EvalCase[] {
  const cases: EvalCase[] = []
  const seen = new Map<string, string>()
  for (const file of paths.flatMap(evalCaseFilesOf)) {
    for (const evalCase of readEvalCaseFile(file)) {
      const earlier = seen.get(evalCase.id)
      if (earlier !== undefined) throw new Error(`eval-runner: case ${JSON.stringify(evalCase.id)} is in both ${earlier} and ${file}`)
      seen.set(evalCase.id, file)
      cases.push(evalCase)
    }
  }
  if (cases.length === 0) throw new Error(`eval-runner: no cases in ${paths.join(', ')}`)
  return cases
}
