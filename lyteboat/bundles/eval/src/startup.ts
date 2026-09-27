/**
 * The eval app's command-line provider. `lyteboat eval --agents <dir> --agent
 * <id>` runs the agent's cases (`--cases` names other case files or
 * directories, `--case` picks cases by id; `--model replay --from <run>`
 * plays a recorded run back without a model; `--run-id` names the run's
 * directory, which must not exist yet); `lyteboat eval compare <before> <after>` compares two
 * runs; `lyteboat eval release --agents <dir> --agent <id>` (also `lyteboat
 * release`) puts the agent through the release gate. A run is named by its
 * directory or by its id under `$LYTEBOAT_HOME/evals`. A bad flag, a missing
 * directory, or a replay without a recorded run is a usage error (exit 2), so
 * nothing is provided.
 * @module @lyteboat/eval/startup
 */

import { randomBytes } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { Command } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { LYTEBOAT_EVAL_RUN_ID_PATTERN } from '@lyteboat/contracts'

/** Service provided by this plugin and injected by the catalog and eval rows. */
export const LYTEBOAT_EVAL_STARTUP_SERVICE = 'lyteboatEvalStartup'

/** Run the cases of one agent. */
export interface LyteboatEvalRunCommand {
  action: 'run'
  agent: string
  /** Case files or directories; empty: the agent directory's `evals/`. */
  cases: string[]
  /** Only these cases, by id; empty: every case. */
  caseIds: string[]
  mode: 'real' | 'replay'
  /** The recorded run a replay plays back. */
  from: string | undefined
  /** Where this run is written: `$LYTEBOAT_HOME/evals/<run id>`. */
  runDir: string
}

/** Compare two runs. */
export interface LyteboatEvalCompareCommand {
  action: 'compare'
  before: string
  after: string
}

/** Put one agent through the release gate and write its lock. */
export interface LyteboatEvalReleaseCommand {
  action: 'release'
  agent: string
  /** Where the baseline's replay is written: `$LYTEBOAT_HOME/evals/<run id>`. */
  runDir: string
}

/** What the rows read from {@link LYTEBOAT_EVAL_STARTUP_SERVICE}. */
export interface LyteboatEvalStartupValues {
  /** Absolute agent roots; empty for a comparison. */
  agentRoots: string[]
  /** The agents the catalog declares: the one the cases talk to, or the one released. */
  include: string[]
  command: LyteboatEvalRunCommand | LyteboatEvalCompareCommand | LyteboatEvalReleaseCommand
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    lyteboatEvalStartup: LyteboatEvalStartupValues
  }
}

const collect = (value: string, previous: string[] = []): string[] => [...previous, value]

const USAGE = { exitCode: 2 }

function isDirectory(path: string): boolean {
  return existsSync(path) && statSync(path).isDirectory()
}

/** A run named by its directory, or by its id under `$LYTEBOAT_HOME/evals`; undefined when neither exists. */
function runDirOf(ref: string): string | undefined {
  if (isDirectory(ref)) return resolve(ref)
  const named = dshHomePath('evals', ref)
  return isDirectory(named) ? named : undefined
}

/** The agent roots and the agent a run or a release names; a missing or empty one is a usage error. */
function agentOf(cmd: Command, options: { agents?: string[]; agent?: string }): { agentRoots: string[]; agent: string } {
  const agentRoots = (options.agents ?? []).map(dir => resolve(dir))
  if (agentRoots.length === 0) cmd.error('error: at least one --agents directory is required', USAGE)
  for (const dir of agentRoots) {
    if (!isDirectory(dir)) cmd.error(`error: --agents directory not found: ${dir}`, USAGE)
  }
  const agent = options.agent ?? ''
  if (agent === '') cmd.error('error: --agent is required', USAGE)
  return { agentRoots, agent }
}

/** A new run's id: its UTC start to the second, and four random hex digits. */
function newRunId(): string {
  return `${new Date().toISOString().replace(/[-:]/gu, '').replace(/\.\d+Z$/u, 'Z')}-${randomBytes(2).toString('hex')}`
}

function command(): Command {
  return new Command()
    .name('lyteboat eval')
    .description('Run an agent\'s eval cases through dsh\'s session controller and check every turn; compare two runs; or release an agent.')
    .helpOption('-h, --help', 'show this help')
    // The subcommands parse their own --agents and --agent.
    .enablePositionalOptions()
    .option('--agents <dir>', 'a directory of agents (repeatable, at least one)', collect)
    .option('--agent <id>', 'the agent whose cases run')
    .option('--cases <path>', 'a case file or a directory of them (repeatable; default: the agent\'s evals/)', collect)
    .option('--case <id>', 'run only this case (repeatable; default: every case)', collect)
    .option('--run-id <id>', 'the run\'s id, its directory under $LYTEBOAT_HOME/evals; it must not exist yet (default: the start time and four random hex digits)')
    .option('--model <mode>', 'real (call the model and record the sessions) or replay (play a recorded run back, no key)', 'real')
    .option('--from <run>', 'the recorded run a replay plays back: its directory or its id under $LYTEBOAT_HOME/evals')
    .addHelpText('after', `
Examples:
  lyteboat eval --agents ./agents --agent finance                         run finance's evals/ against the model and record them
  lyteboat eval --agents ./agents --agent finance --model replay --from <run>
                                                                          play a recorded run back without a model
  lyteboat eval --agents ./agents --agent finance --case asset-overview   run one case
  lyteboat eval compare <before> <after>                                  list the checks whose results changed
  lyteboat eval release --agents ./agents --agent finance                 check finance against its baseline and write its release lock
`)
}

export default class LyteboatEvalStartup {
  /** Services required before the invocation can be read. */
  static inject = ['cmdlineArgs']

  /**
   * Parse and provide the invocation.
   * @param ctx - plugin context carrying the command line.
   */
  constructor(ctx: Context) {
    const program = command()
    program.action(() => {
      const options = program.opts<{ agents?: string[]; agent?: string; cases?: string[]; case?: string[]; runId?: string; model: string; from?: string }>()
      const { agentRoots, agent } = agentOf(program, options)
      if (options.model !== 'real' && options.model !== 'replay') program.error('error: --model must be real or replay', USAGE)
      // program.error() exits, but TypeScript cannot narrow through it.
      const mode = options.model === 'replay' ? 'replay' : 'real'
      const from = options.from === undefined ? undefined : runDirOf(options.from)
      if (options.from !== undefined && from === undefined) program.error(`error: --from names no eval run: ${options.from}`, USAGE)
      if (mode === 'replay' && from === undefined) program.error('error: --model replay needs --from, the recorded run to play back', USAGE)
      const cases = (options.cases ?? []).map(path => resolve(path))
      if (options.runId !== undefined && !LYTEBOAT_EVAL_RUN_ID_PATTERN.test(options.runId)) program.error(`error: --run-id must be letters, digits, dots, dashes, and underscores, not ${options.runId}`, USAGE)
      const runDir = dshHomePath('evals', options.runId ?? newRunId())
      if (existsSync(runDir)) program.error(`error: --run-id names a run that exists: ${runDir}`, USAGE)
      ctx.provide(LYTEBOAT_EVAL_STARTUP_SERVICE, {
        agentRoots,
        include: [agent],
        command: { action: 'run', agent, cases, caseIds: options.case ?? [], mode, from, runDir },
      } satisfies LyteboatEvalStartupValues)
    })
    program.command('compare')
      .description('list the checks whose results differ between two runs; a check that passed before and fails now is a regression (exit 1)')
      .argument('<before>', 'the earlier run: its directory or its id under $LYTEBOAT_HOME/evals')
      .argument('<after>', 'the later run')
      .action((beforeRef: string, afterRef: string) => {
        const before = runDirOf(beforeRef)
        const after = runDirOf(afterRef)
        if (before === undefined) program.error(`error: no eval run ${beforeRef}`, USAGE)
        if (after === undefined) program.error(`error: no eval run ${afterRef}`, USAGE)
        ctx.provide(LYTEBOAT_EVAL_STARTUP_SERVICE, {
          agentRoots: [],
          include: [],
          command: { action: 'compare', before: before ?? '', after: after ?? '' },
        } satisfies LyteboatEvalStartupValues)
      })
    const release = program.command('release')
      .description('put an agent through the release gate and write <agent>/agent.release.json: agent.yml declares a version and a model; evals/baseline is a real run of this agent on that model; replaying it shows every turn as recorded and passes; no lock releases the same version with other content (exit 1 when the gate refuses)')
      .option('--agents <dir>', 'a directory of agents (repeatable, at least one)', collect)
      .option('--agent <id>', 'the agent to release')
      .action((options: { agents?: string[]; agent?: string }) => {
        const { agentRoots, agent } = agentOf(release, options)
        ctx.provide(LYTEBOAT_EVAL_STARTUP_SERVICE, {
          agentRoots,
          include: [agent],
          command: { action: 'release', agent, runDir: dshHomePath('evals', newRunId()) },
        } satisfies LyteboatEvalStartupValues)
      })
    parseCmdline(ctx, program)
  }
}
