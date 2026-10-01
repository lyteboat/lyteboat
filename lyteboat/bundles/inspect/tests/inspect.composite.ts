/**
 * The inspect composition in process (dsh-base, @lyteboat/base,
 * @lyteboat/inspect) over fixture agents: a mounted agent's tools, how
 * each reaches the model, its skills with their checks, and its case files,
 * as text and as a {@link LyteboatInspectResult}; an agent that does not mount
 * exits 1 with the reason; no root holding the agent, or a missing flag, is a
 * usage error. No model is called.
 */
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { lyteboatInspectResultSchema, type LyteboatInspectResult } from '@lyteboat/contracts/cli'
import { LYTEBOAT_INSPECT_BUNDLES, bootComposition, type CompositionRun } from '@lyteboat/testing/composition'
import { createLyteboatScratch } from '@lyteboat/testing/scratch'

const AGENTS = fileURLToPath(new URL('./fixtures/agents', import.meta.url))

describe('lyteboat inspect (in process)', () => {
  const scratch = createLyteboatScratch('inspect')
  let home: string
  let workspace: string

  const inspect = (args: readonly string[]): Promise<CompositionRun> =>
    bootComposition({ bundles: LYTEBOAT_INSPECT_BUNDLES, args, cwd: workspace, home, env: {} })
  const parsed = (run: CompositionRun): LyteboatInspectResult => lyteboatInspectResultSchema.parse(JSON.parse(run.stdout))

  beforeAll(() => {
    ;({ home, workspace } = scratch.run('inspect'))
  })

  afterAll(() => {
    scratch.remove()
  })

  it('prints a mounted agent\'s tools, skills and their checks, and case files as one result object', async () => {
    const run = await inspect(['--agents', AGENTS, '--agent', 'desk', '--result', 'json'])

    expect(run.code, run.stderr).toBe(0)
    const result = parsed(run)
    if (!result.mounted) throw new Error(`desk did not mount: ${result.failure}`)
    expect(result.identity).toMatchObject({ id: 'desk', version: '0.2.0', digest: expect.stringMatching(/^sha256:/u) })
    expect(result.tools.map(tool => [tool.name, tool.reach]).sort()).toEqual([['desk_clock', 'always'], ['lookup_quote', 'activated'], ['skill', 'always']])
    expect(result.skills.map(skill => skill.name)).toEqual(['desk-help', 'quote-lookup'])
    expect(result.routing.mode).toBe('dynamic')
    const failed = result.findings.flatMap(({ skill, findings }) => findings.filter(finding => !finding.passed).map(finding => ({ skill, rule: finding.rule, tools: finding.tools })))
    expect(failed).toEqual([{ skill: 'desk-help', rule: 'required-tools-auto', tools: ['desk_clock'] }])
    expect(result.cases).toEqual([{ file: 'evals/cases.yml', cases: ['time', 'quote'] }])
  })

  it('prints the same as text, with the failed check named', async () => {
    const run = await inspect(['--agents', AGENTS, '--agent', 'desk'])

    expect(run.code, run.stderr).toBe(0)
    expect(run.stdout).toMatch(/^lyteboat inspect: desk 0\.2\.0 \(sha256:[0-9a-f]+\) mounted$/mu)
    expect(run.stdout).toContain('  lookup_quote  activated  required by quote-lookup')
    expect(run.stdout).toContain('checks: 9 passed, 1 failed')
    expect(run.stdout).toContain('  △ desk-help required-tools-auto: desk_clock')
    expect(run.stdout).toContain('  evals/cases.yml (2)')
  })

  it('exits 1 with the reason when the agent does not mount', async () => {
    const run = await inspect(['--agents', AGENTS, '--agent', 'broken', '--result', 'json'])

    expect(run.code).toBe(1)
    expect(parsed(run)).toMatchObject({ agent: 'broken', mounted: false, failure: expect.stringContaining('@lyteboat/no-such-plugin'), cases: [] })
  })

  it('is a usage error when no root holds the agent, or the agent is not named', async () => {
    const unknown = await inspect(['--agents', AGENTS, '--agent', 'nobody'])
    const unnamed = await inspect(['--agents', AGENTS])

    expect(unknown.code).toBe(2)
    expect(unknown.stderr).toContain('nobody')
    expect(unnamed.code).toBe(2)
    expect(unnamed.stderr).toContain('--agent is required')
  })
})
