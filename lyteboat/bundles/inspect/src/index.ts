/**
 * @lyteboat/inspect — lyteboat's inspect mode. The bundle patch rides over
 * dsh-base, @lyteboat/host, and the business base: it declares one agent
 * (`@lyteboat/agent-catalog`, reporting a failure rather than refusing the
 * tree) and mounts the agent inspector and the eval records. This row runs
 * once the tree has settled: it reads what the agent is made of (its tools
 * and how each reaches the model, its skills and their checks, its eval case
 * files), prints it as text or as one {@link LyteboatInspectResult}, and
 * exits: 0 when the agent mounted, 1 when it did not, 2 when no root holds it.
 * @module @lyteboat/inspect
 */

import { relative, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-cmdline'
import type {} from '@lyteboat/agent-catalog'
import type {} from '@lyteboat/agent-inspector'
import type { LyteboatInspectedCaseFile, LyteboatInspectMounted, LyteboatInspectResult } from '@lyteboat/contracts/cli'
import type {} from '@lyteboat/eval-runner/records'
import type {} from './startup.ts'

function caseFilesOf(ctx: Context, agentDir: string): LyteboatInspectedCaseFile[] {
  return ctx.evalRecords.cases(agentDir).map(listing => ({
    file: relative(agentDir, listing.file).split(sep).join('/'),
    cases: listing.cases.map(evalCase => evalCase.id),
    ...listing.error === undefined ? {} : { error: listing.error },
  }))
}

async function inspect(ctx: Context, agent: string): Promise<LyteboatInspectResult> {
  let unready: unknown
  try {
    await ctx.agentCatalog.whenReady()
  } catch (error: unknown) {
    unready = error
  }
  const entry = ctx.agentCatalog.get(agent)
  if (entry === undefined) {
    const failure = ctx.agentCatalog.failures().find(candidate => candidate.id === agent)
    if (failure === undefined) throw unready ?? new Error(`no --agents directory holds agent "${agent}"`)
    return { agent, mounted: false, failure: failure.reason, cases: caseFilesOf(ctx, failure.dir) }
  }
  const [tools, skills, findings] = await Promise.all([ctx.agentInspector.tools(agent), ctx.agentInspector.skills(agent), ctx.agentInspector.findings(agent)])
  if (tools === undefined || skills === undefined || findings === undefined) throw new Error(`agent "${agent}" left the catalog while it was inspected`)
  return { agent, mounted: true, identity: entry.identity, tools, skills: skills.skills, routing: skills.routing, findings, cases: caseFilesOf(ctx, entry.dir) }
}

function mountedText(result: LyteboatInspectMounted): string {
  const { identity } = result
  const lines = [`lyteboat inspect: ${identity.id}${identity.version === undefined ? '' : ` ${identity.version}`} (${identity.digest}) mounted`]
  lines.push(`tools (${String(result.tools.length)}):`)
  for (const tool of result.tools) {
    lines.push(`  ${tool.name}  ${tool.reach}${tool.requiredBy.length === 0 ? '' : `  required by ${tool.requiredBy.join(', ')}`}`)
  }
  lines.push(`skills (${String(result.skills.length)}), routing ${result.routing.mode}:`)
  for (const skill of result.skills) {
    lines.push(`  ${skill.name}${skill.requiredTools.length === 0 ? '' : `  requires ${skill.requiredTools.join(', ')}`}`)
  }
  const checks = result.findings.flatMap(({ skill, findings }) => findings.map(finding => ({ skill, finding })))
  const failed = checks.filter(({ finding }) => !finding.passed)
  lines.push(`checks: ${String(checks.length - failed.length)} passed, ${String(failed.length)} failed`)
  for (const { skill, finding } of failed) {
    const subject = finding.tools.length > 0 ? `: ${finding.tools.join(', ')}` : finding.problem === undefined ? '' : `: ${finding.problem}`
    lines.push(`  ${finding.level === 'error' ? '✗' : '△'} ${skill} ${finding.rule}${subject}`)
  }
  return lines.join('\n')
}

function resultText(result: LyteboatInspectResult): string {
  const head = result.mounted ? mountedText(result) : `lyteboat inspect: ${result.agent} did not mount: ${result.failure}`
  const cases = result.cases.map(file => `  ${file.file}${file.error === undefined ? ` (${String(file.cases.length)})` : `: ${file.error}`}`)
  return [head, `eval case files (${String(result.cases.length)}):`, ...cases].join('\n') + '\n'
}

export default class LyteboatInspectRunner {
  /** The rows this one reads. */
  static inject = ['agentCatalog', 'agentInspector', 'evalRecords', 'lyteboatInspectStartup']

  /**
   * Inspect, print, and exit with the result.
   * @param ctx - plugin context carrying the catalog, the inspector, the eval records, the invocation, and the launcher's exit request.
   */
  constructor(ctx: Context) {
    const exit = ctx.get('appExit')
    if (exit === undefined) throw new Error('lyteboat-inspect: the launcher must provide ctx.appExit before the tree mounts')
    void (async () => {
      await ctx.get('loader')?.await()
      const { agent, result: format } = ctx.lyteboatInspectStartup
      try {
        const result = await inspect(ctx, agent)
        process.stdout.write(format === 'json' ? `${JSON.stringify(result)}\n` : resultText(result))
        exit(result.mounted ? 0 : 1)
      } catch (error: unknown) {
        process.stderr.write(`lyteboat: ${error instanceof Error ? error.message : String(error)}\n`)
        exit(2)
      }
    })()
  }
}
