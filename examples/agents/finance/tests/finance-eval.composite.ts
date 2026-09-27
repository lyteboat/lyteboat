/**
 * The finance agent's eval cases replayed from their baseline (in process, no
 * model, no key): `evals/baseline` is a real run of `evals/cases.yml`, and a
 * replay of it through today's composition must show every turn as the
 * baseline recorded it. A change to the agent or the framework that changes
 * what a turn shows — its skill, tools, cards, outcome, or text — fails here.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { LYTEBOAT_EVAL_BUNDLES, bootComposition } from '@lyteboat/testing/composition'
import { createLyteboatScratch } from '@lyteboat/testing/scratch'
import { AGENTS } from './support/finance-model.ts'

const BASELINE = fileURLToPath(new URL('../evals/baseline', import.meta.url))

describe('finance eval cases replayed from their baseline (in process, no model)', () => {
  const scratch = createLyteboatScratch('finance-eval')

  afterAll(() => { scratch.remove() })

  it('shows every turn as the baseline recorded it', async () => {
    const { home, workspace } = scratch.run('replay')

    const run = await bootComposition({
      bundles: LYTEBOAT_EVAL_BUNDLES,
      args: ['--agents', AGENTS, '--agent', 'finance', '--model', 'replay', '--from', BASELINE],
      cwd: workspace,
      home,
      env: { DSH_TELEMETRY_DISABLED: '1' },
    })

    const runDir = /; report: (\S+)\/report\.md$/mu.exec(run.stdout)?.[1] ?? ''
    expect(runDir, `${run.stdout}\n${run.stderr}`).not.toBe('')
    expect(readFileSync(join(runDir, 'results.jsonl'), 'utf8')).toBe(readFileSync(join(BASELINE, 'results.jsonl'), 'utf8'))
    const baseline = JSON.parse(readFileSync(join(BASELINE, 'run.json'), 'utf8')) as { agent: unknown; cases: { pass: boolean }[] }
    expect(run.code, run.stderr).toBe(baseline.cases.every(evalCase => evalCase.pass) ? 0 : 1)
  })

  it('replays the agent the baseline recorded, so the release gate\'s stamps hold', async () => {
    const { home, workspace } = scratch.run('stamps')

    const run = await bootComposition({
      bundles: LYTEBOAT_EVAL_BUNDLES,
      args: ['--agents', AGENTS, '--agent', 'finance', '--model', 'replay', '--from', BASELINE],
      cwd: workspace,
      home,
      env: { DSH_TELEMETRY_DISABLED: '1' },
    })

    const runDir = /; report: (\S+)\/report\.md$/mu.exec(run.stdout)?.[1] ?? ''
    const replayed = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8')) as { agent: unknown }
    const baseline = JSON.parse(readFileSync(join(BASELINE, 'run.json'), 'utf8')) as { agent: unknown }
    expect(replayed.agent, 'the agent directory changed since its baseline was recorded: record it again (docs/03 §4.16)').toEqual(baseline.agent)
  })
})
