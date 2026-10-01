/**
 * Runs the official dsh CLI (`dsh headless`) of an install tree
 * (scripts/dist/trees.ts) against upstream's scripted model server, and reads
 * the session it wrote. G4, G5, and G6 compare what two trees write for the
 * same run: the official release, and the same release with lyteboat's kernel.
 * @module dsh-compat/tests/support/official-cli
 */

import { spawn } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startMockLlmServer, type MockLlmBehavior, type MockLlmServerOptions } from '@deepseek-ai/dsh-llm-mock-server'
import { findSessionLogs, normalizeSessionLog, readSessionLog, type SessionLogRecord } from '@lyteboat/testing/session-log'

/** One scripted run: the task, the model's behaviors in order, and the workspace it runs in. */
export interface OfficialScenario {
  name: string
  task: string
  sequence: MockLlmBehavior[]
  mock?: Omit<MockLlmServerOptions, 'sequence' | 'port' | 'apiKey'>
  files?: Record<string, string>
  /** Extra patch-list overlay lines for the profile (YAML), e.g. a canary's row. */
  patch?: string
}

/** What a run left behind: its output and its session log, raw and normalized. */
export interface OfficialRun {
  code: number | null
  stdout: string
  stderr: string
  home: string
  cwd: string
  records: SessionLogRecord[]
  normalized: SessionLogRecord[]
  sessionId: string | undefined
  requests: number
}

/** The session title plugin asks the model for a title; the scripted sequence is for the task alone. */
const QUIET_PATCH = '- id: session-title-llm\n  disabled: true\n'

/**
 * lyteboat's distribution policy (COMPAT.md §8): its dsh-base turns these rows
 * off. Both trees get the same entries, so a comparison is about the kernel,
 * not the default composition; without them the official log alone carries
 * session-log-deepseek's delivery records.
 */
const DISTRIBUTION_POLICY_PATCH = ['session-log-deepseek', 'plugin-package-inventory-deepseek', 'session-telemetry-otel']
  .map(id => `- id: ${id}\n  disabled: true\n`).join('')

/**
 * dsh resolves HTTP(S)_PROXY for model requests; the scripted model listens on
 * loopback, so the child gets none of them. Installs keep the ambient proxy.
 */
const PROXY_VARIABLES = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']

/** The environment a tree's CLI runs with: its own DSH_HOME, the scripted model, no telemetry, no proxy. */
function cliEnvironment(home: string, baseURL?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' }
  for (const name of PROXY_VARIABLES) delete env[name]
  if (baseURL !== undefined) Object.assign(env, { DEEPSEEK_BASE_URL: `${baseURL}/v1`, DEEPSEEK_API_KEY: 'mock-key' })
  return env
}

/** Spawn `dsh <args>` from a tree and collect its output. */
export function runDsh(tree: string, args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv }): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(tree, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), ...args], { cwd: options.cwd, env: options.env })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.on('error', reject)
    child.on('close', code => { resolve({ code, stdout, stderr }) })
  })
}

/** A fresh directory pair for one run, under a per-suite root. */
export function freshRun(root: string, label: string, files: Record<string, string> = {}): { home: string; cwd: string } {
  const home = join(root, `${label}-home`)
  const cwd = join(root, `${label}-work`)
  for (const dir of [home, cwd]) {
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
  }
  for (const [name, text] of Object.entries(files)) writeFileSync(join(cwd, name), text)
  return { home, cwd }
}

/**
 * Run `dsh headless <task>` from `tree` in `home`/`cwd` against a scripted
 * model of its own (a shared one would hand the second run the tail of the
 * first run's script), then read the session log the run left.
 */
export async function runScenario(tree: string, scenario: OfficialScenario, place: { home: string; cwd: string }, extraArgs: readonly string[] = []): Promise<OfficialRun> {
  const patchFile = join(place.home, 'compatibility.patch.yml')
  writeFileSync(patchFile, `${QUIET_PATCH}${DISTRIBUTION_POLICY_PATCH}${scenario.patch ?? ''}`)
  const mock = await startMockLlmServer({ ...scenario.mock, sequence: scenario.sequence, port: 0, apiKey: 'mock-key' })
  let result
  try {
    result = await runDsh(tree, ['headless', '--patch', patchFile, ...extraArgs, scenario.task], { cwd: place.cwd, env: cliEnvironment(place.home, mock.baseURL) })
  } finally {
    await mock.close()
  }
  const [log] = findSessionLogs(place.home)
  const records = log === undefined ? [] : readSessionLog(log)
  const header = records.find(record => record['type'] === 'session')
  return {
    ...result,
    home: place.home,
    cwd: place.cwd,
    records,
    normalized: normalizeSessionLog(records, { cwd: place.cwd, home: place.home }),
    sessionId: typeof header?.['id'] === 'string' ? header['id'] : undefined,
    requests: mock.requests.length,
  }
}

/** Copy a finished run's home and workspace, so another tree can resume its session in place. */
export function cloneRun(run: Pick<OfficialRun, 'home' | 'cwd'>, root: string, label: string): { home: string; cwd: string } {
  const target = { home: join(root, `${label}-home`), cwd: run.cwd }
  rmSync(target.home, { recursive: true, force: true })
  cpSync(run.home, target.home, { recursive: true })
  return target
}

/** A per-suite scratch root. */
export function suiteRoot(name: string): string {
  return mkdtempSync(join(tmpdir(), `lyteboat-dsh-compat-${name}-`))
}
