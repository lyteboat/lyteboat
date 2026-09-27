/**
 * @lyteboat/eval — lyteboat's eval mode. The bundle patch rides over dsh-base
 * and @lyteboat/host: it declares the agent the cases talk to
 * (`@lyteboat/agent-catalog`), mounts dsh's session controller without the
 * web UI (workspace, connection, file upload), and runs
 * `@lyteboat/eval-runner`. This row runs the invocation once the tree has
 * settled, prints each case as it finishes and where the report is, and
 * exits: 0 when every check passed, 1 when one failed (or, comparing, when
 * a check that passed before fails now; releasing, when the gate refused),
 * 2 when the run could not start.
 * @module @lyteboat/eval
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-cmdline'
import type {} from '@lyteboat/contracts'
import type { EvalChange, EvalTurnResult } from '@lyteboat/eval-runner'
import type { LyteboatEvalCompareCommand, LyteboatEvalReleaseCommand, LyteboatEvalRunCommand } from './startup.ts'

/** One case as the terminal shows it: ✓ with its turn count, or ✗ with each failed turn's checks. */
function caseLine(id: string, results: readonly EvalTurnResult[]): string {
  const failed = results.filter(result => !result.pass)
  if (failed.length === 0) return `✓ ${id} (${String(results.length)} turn${results.length === 1 ? '' : 's'})\n`
  return `✗ ${id}: ${failed.map(result => `turn ${String(result.turn)} ${result.checks.filter(check => !check.pass).map(check => check.check).join(', ')}`).join('; ')}\n`
}

async function runCases(ctx: Context, command: LyteboatEvalRunCommand): Promise<number> {
  const { record } = await ctx.evalRunner.run({
    agentId: command.agent,
    cases: command.cases,
    ...command.caseIds.length === 0 ? {} : { caseIds: command.caseIds },
    mode: command.mode,
    ...command.from === undefined ? {} : { from: command.from },
    out: command.runDir,
    onCase: (evalCase, results) => { process.stdout.write(caseLine(evalCase.id, results)) },
  })
  const passed = record.cases.filter(evalCase => evalCase.pass).length
  process.stdout.write(`lyteboat eval: ${String(passed)}/${String(record.cases.length)} cases passed (turns ${String(record.turns.passed)}/${String(record.turns.total)}, checks ${String(record.checks.passed)}/${String(record.checks.total)}); report: ${command.runDir}/report.md\n`)
  return passed === record.cases.length ? 0 : 1
}

function compareRuns(ctx: Context, command: LyteboatEvalCompareCommand): number {
  const changes = ctx.evalRunner.compare(command.before, command.after)
  const regressions = (change: EvalChange): boolean => change.before === 'pass' && change.after !== 'pass'
  for (const change of changes) {
    process.stdout.write(`${regressions(change) ? '✗' : '·'} ${change.case} turn ${String(change.turn)} ${change.check}: ${change.before} → ${change.after}\n`)
  }
  const count = changes.filter(regressions).length
  process.stdout.write(`lyteboat eval compare: ${String(changes.length)} change${changes.length === 1 ? '' : 's'}, ${String(count)} regression${count === 1 ? '' : 's'}\n`)
  return count === 0 ? 0 : 1
}

async function releaseAgent(ctx: Context, command: LyteboatEvalReleaseCommand): Promise<number> {
  const outcome = await ctx.evalRunner.release({ agentId: command.agent, dshBase: ctx.lyteboatDistro.dsh, out: command.runDir })
  if (!outcome.released) {
    process.stderr.write(`lyteboat release: refused at ${outcome.step}: ${outcome.reason}\n`)
    return 1
  }
  const { agent } = outcome.release
  process.stdout.write(`lyteboat release: ${agent.id} ${agent.version} (${agent.digest}) released; lock: ${outcome.file}; replay: ${command.runDir}/report.md\n`)
  return 0
}

export default class LyteboatEvalRunner {
  /** The rows this one drives. */
  static inject = ['evalRunner', 'lyteboatEvalStartup', 'lyteboatDistro']

  /**
   * Run, compare, or release, then exit with the result.
   * @param ctx - plugin context carrying the eval runner, the invocation, and the launcher's exit request.
   */
  constructor(ctx: Context) {
    const exit = ctx.get('appExit')
    if (exit === undefined) throw new Error('lyteboat-eval: the launcher must provide ctx.appExit before the tree mounts')
    void (async () => {
      await ctx.get('loader')?.await()
      const { command } = ctx.lyteboatEvalStartup
      try {
        exit(command.action === 'compare' ? compareRuns(ctx, command) : command.action === 'release' ? await releaseAgent(ctx, command) : await runCases(ctx, command))
      } catch (error: unknown) {
        process.stderr.write(`lyteboat: ${error instanceof Error ? error.message : String(error)}\n`)
        exit(2)
      }
    })()
  }
}
