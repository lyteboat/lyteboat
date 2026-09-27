/**
 * The release gate and the lock it writes. An agent may be released when its
 * `agent.yml` declares a version and a model; its baseline (`evals/baseline`)
 * is a real run of this very agent (every human message went to the agent's
 * current identity) on that model (every loop request's header names it); a
 * replay of the baseline through this build shows every turn as the baseline
 * recorded it, and passes; and no lock already releases the same version with
 * other content. The lock, `agent.release.json` beside the manifest, has its
 * keys in a fixed order, two-space indentation, and one final newline, so
 * releasing the same agent again writes the same bytes.
 * @module @lyteboat/eval-runner/eval-release
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentCatalogEntry } from '@lyteboat/agent-catalog'
import { LYTEBOAT_AGENT_RELEASE_FILE, lyteboatAgentReleaseSchema, lyteboatEvalRunRecordSchema, type LyteboatAgentIdentity, type LyteboatAgentModel, type LyteboatAgentRelease, type LyteboatEvalRunRecord } from '@lyteboat/contracts'
import { recordedAgentsOf, recordedModelsOf } from './eval-recording.ts'
import { evalRunRecordFile, evalRunResultsFile, recordedSessionFile, type EvalTurnResult } from './eval-report.ts'

/** The release lock's file name in the agent directory. */

/** The gate step that refused a release. */
export type EvalReleaseStep = 'manifest' | 'baseline' | 'stamps' | 'model' | 'replay' | 'version'

/** A release: the lock written, or the step that refused it and why. */
export type EvalReleaseOutcome =
  | { released: true; file: string; release: LyteboatAgentRelease }
  | { released: false; step: EvalReleaseStep; reason: string }

/** Replays a baseline directory through this build. */
export type EvalBaselineReplay = (baselineDir: string) => Promise<{ record: LyteboatEvalRunRecord; results: readonly EvalTurnResult[] }>

class EvalReleaseRefusal extends Error {
  constructor(readonly step: EvalReleaseStep, reason: string) {
    super(reason)
  }
}

const sha256Hex = (data: string): string => createHash('sha256').update(data).digest('hex')

function describeAgent(identity: LyteboatAgentIdentity): string {
  return `${identity.id}${identity.version === undefined ? '' : ` ${identity.version}`} (${identity.digest})`
}

function describeModel(model: LyteboatAgentModel): string {
  return `${model.provider}/${model.model}${model.reasoningEffort === undefined ? '' : ` (reasoningEffort ${model.reasoningEffort})`}`
}

const sameIdentity = (a: LyteboatAgentIdentity | undefined, b: LyteboatAgentIdentity): boolean =>
  a !== undefined && a.id === b.id && a.version === b.version && a.digest === b.digest

const sameModel = (a: LyteboatAgentModel, b: LyteboatAgentModel): boolean =>
  a.provider === b.provider && a.model === b.model && a.reasoningEffort === b.reasoningEffort

function readJsonFile(file: string, step: EvalReleaseStep): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (error: unknown) {
    throw new EvalReleaseRefusal(step, `${file} cannot be read as JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function readBaseline(baselineDir: string): LyteboatEvalRunRecord {
  const file = evalRunRecordFile(baselineDir)
  if (!existsSync(file)) throw new EvalReleaseRefusal('baseline', `no baseline at ${baselineDir}: run lyteboat eval with the real model and copy its run directory there`)
  const parsed = lyteboatEvalRunRecordSchema.safeParse(readJsonFile(file, 'baseline'))
  if (!parsed.success) throw new EvalReleaseRefusal('baseline', `${file} is not a run this build reads (${parsed.error.issues.map(issue => `${issue.path.join('.') || '(the file)'}: ${issue.message}`).join('; ')}); record the baseline again`)
  if (parsed.data.mode !== 'real') throw new EvalReleaseRefusal('baseline', `${baselineDir} is a replay; a release baseline must be a real run`)
  return parsed.data
}

/** A recording's lines: the runner's own output, a header line, then one event per line. */
function readRecording(file: string): unknown[] {
  return readFileSync(file, 'utf8').split('\n').filter(line => line.trim() !== '').map((line, index) => {
    try {
      return JSON.parse(line) as unknown
    } catch (error: unknown) {
      throw new EvalReleaseRefusal('baseline', `${file}: line ${String(index + 1)} is not JSON (${error instanceof Error ? error.message : String(error)}); record the baseline again`)
    }
  })
}

/** Every recorded request of the baseline went to this agent, on the declared model. */
function checkRecordings(baselineDir: string, baseline: LyteboatEvalRunRecord, identity: LyteboatAgentIdentity, model: LyteboatAgentModel): void {
  if (!sameIdentity(baseline.agent, identity)) throw new EvalReleaseRefusal('stamps', `the baseline ran ${describeAgent(baseline.agent)}, but the agent is now ${describeAgent(identity)}; record the baseline again`)
  for (const evalCase of baseline.cases) {
    const file = recordedSessionFile(baselineDir, evalCase.id)
    if (!existsSync(file)) throw new EvalReleaseRefusal('baseline', `the baseline has no recorded session for case ${evalCase.id} (${file})`)
    const events = readRecording(file)
    const agents = recordedAgentsOf(events)
    const strangerAt = agents.findIndex(agent => !sameIdentity(agent, identity))
    if (strangerAt !== -1) {
      const stranger = agents[strangerAt]
      throw new EvalReleaseRefusal('stamps', `${file}: a request went to ${stranger === undefined ? 'no named agent' : describeAgent(stranger)}, but the agent is now ${describeAgent(identity)}; record the baseline again`)
    }
    const other = recordedModelsOf(events).find(used => !sameModel(used, model))
    if (other !== undefined) throw new EvalReleaseRefusal('model', `${file}: a request used ${describeModel(other)}, but agent.yml declares ${describeModel(model)}; record the baseline on the declared model`)
  }
}

/**
 * A replay of the baseline through this build runs the baseline's cases (so
 * every replayed case is one whose recordings were checked), shows every turn
 * as recorded, and passes.
 */
async function checkReplay(baselineDir: string, baseline: LyteboatEvalRunRecord, replay: EvalBaselineReplay): Promise<string> {
  const resultsFile = evalRunResultsFile(baselineDir)
  if (!existsSync(resultsFile)) throw new EvalReleaseRefusal('baseline', `the baseline has no results.jsonl (${resultsFile}); copy the whole run directory`)
  // A checkout on Windows may hold the baseline with CRLF; the replay writes LF, and the lock's digest must not depend on the host.
  const recorded = readFileSync(resultsFile, 'utf8').replaceAll('\r\n', '\n')
  let replayed: Awaited<ReturnType<EvalBaselineReplay>>
  try {
    replayed = await replay(baselineDir)
  } catch (error: unknown) {
    throw new EvalReleaseRefusal('replay', `replaying the baseline failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  const recordedCases = baseline.cases.map(evalCase => evalCase.id).join(', ')
  const replayedCases = replayed.record.cases.map(evalCase => evalCase.id).join(', ')
  if (replayedCases !== recordedCases) throw new EvalReleaseRefusal('replay', `the agent's cases are now ${replayedCases || '(none)'}, but the baseline ran ${recordedCases || '(none)'}; record the baseline again`)
  const lines = recorded.split('\n').filter(line => line !== '')
  const differing = replayed.results.find((result, index) => JSON.stringify(result) !== lines[index])
  if (differing !== undefined) throw new EvalReleaseRefusal('replay', `replaying the baseline, case ${differing.case} turn ${String(differing.turn)} no longer shows what the baseline recorded`)
  if (replayed.results.length !== lines.length) throw new EvalReleaseRefusal('replay', `replaying the baseline gave ${String(replayed.results.length)} turn(s); the baseline recorded ${String(lines.length)}`)
  const failing = replayed.record.cases.filter(evalCase => !evalCase.pass).map(evalCase => evalCase.id)
  if (failing.length > 0) throw new EvalReleaseRefusal('replay', `the baseline fails case(s) ${failing.join(', ')}; a release needs every case to pass`)
  return recorded
}

/** No lock already releases this version with other content. */
function checkEarlierRelease(file: string, identity: LyteboatAgentIdentity & { version: string }): void {
  if (!existsSync(file)) return
  const parsed = lyteboatAgentReleaseSchema.safeParse(readJsonFile(file, 'version'))
  if (!parsed.success) throw new EvalReleaseRefusal('version', `${file} is not a release lock this build reads; remove it to release again`)
  const earlier = parsed.data.agent
  if (earlier.version === identity.version && earlier.digest !== identity.digest) {
    throw new EvalReleaseRefusal('version', `${file} already releases ${identity.id} ${identity.version} as ${earlier.digest}; raise the version in agent.yml`)
  }
}

/**
 * Put an agent through the release gate and, when it passes, write its lock.
 * @param agent - the agent as the catalog mounted it.
 * @param dshBase - the dsh release of this build's kernel.
 * @param replay - replays the baseline through this build.
 * @returns the lock written, or the step that refused it.
 */
export async function releaseAgent(agent: AgentCatalogEntry, dshBase: string, replay: EvalBaselineReplay): Promise<EvalReleaseOutcome> {
  const { id, version, digest } = agent.identity
  const { model } = agent
  if (version === undefined || model === undefined) return { released: false, step: 'manifest', reason: `${join(agent.dir, 'agent.yml')} must declare a version and a model to be released` }
  const baselineDir = join(agent.dir, 'evals', 'baseline')
  const file = join(agent.dir, LYTEBOAT_AGENT_RELEASE_FILE)
  try {
    const baseline = readBaseline(baselineDir)
    checkRecordings(baselineDir, baseline, agent.identity, model)
    const recorded = await checkReplay(baselineDir, baseline, replay)
    checkEarlierRelease(file, { id, version, digest })
    const release: LyteboatAgentRelease = {
      agent: { id, version, digest },
      model: { provider: model.provider, model: model.model, ...model.reasoningEffort === undefined ? {} : { reasoningEffort: model.reasoningEffort } },
      dshBase,
      files: { ...agent.files },
      baseline: { startedAt: baseline.startedAt, cases: baseline.cases.length, turns: baseline.turns.total, checks: baseline.checks.total, results: `sha256:${sha256Hex(recorded)}` },
    }
    writeFileSync(file, JSON.stringify(release, null, 2) + '\n')
    return { released: true, file, release }
  } catch (error: unknown) {
    if (error instanceof EvalReleaseRefusal) return { released: false, step: error.step, reason: error.message }
    throw error
  }
}
