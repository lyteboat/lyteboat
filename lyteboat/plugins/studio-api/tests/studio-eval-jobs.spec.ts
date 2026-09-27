/**
 * The Studio's eval jobs across a restart: a job still running when the
 * Studio starts is interrupted, keeping the cases its output shows finished,
 * and its run shows the result its process went on to write; a job file cut
 * short is skipped; a run reads as running until its process exits; an
 * interrupted run whose process still runs reads as running and can be
 * stopped from the restarted Studio.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { EvalRunListing } from '@lyteboat/eval-runner/records'
import { lyteboatTempDir } from '@lyteboat/testing/scratch'
import { StudioEvalJobs, type StudioEvalJob } from '../src/studio-eval-jobs.ts'
import { studioEvalRunOf } from '../src/studio-eval-runs.ts'

const RUNNING: StudioEvalJob = {
  runId: '20260926T000000Z-abcd', agentId: 'alpha', mode: 'real', startedAt: 1_000, startedBy: 'root', pid: 999_999,
  status: 'running', casesTotal: 2, casesDone: 0, casesPassed: 0,
}

describe('the Studio\'s eval jobs', () => {
  it('marks a job still running when the Studio starts as interrupted, with the cases its output shows finished, and skips a torn file', () => {
    const studioDir = lyteboatTempDir('studio-eval-jobs')
    mkdirSync(join(studioDir, 'eval-jobs'))
    writeFileSync(join(studioDir, 'eval-jobs', `${RUNNING.runId}.json`), JSON.stringify(RUNNING))
    writeFileSync(join(studioDir, 'eval-jobs', `${RUNNING.runId}.log`), '✓ first (1 turn)\n')
    writeFileSync(join(studioDir, 'eval-jobs', 'torn.json'), '{"runId":')
    const warnings: string[] = []

    const jobs = new StudioEvalJobs(studioDir, undefined, message => warnings.push(message))

    expect(jobs.list()).toEqual([{ ...RUNNING, status: 'interrupted', casesDone: 1, casesPassed: 1 }])
    expect(warnings).toEqual([])
    expect(jobs.get('../escape')).toBeUndefined()
  })

  it('shows an interrupted job\'s run by the result its process wrote, and as interrupted until it does', () => {
    const job: StudioEvalJob = { ...RUNNING, status: 'interrupted', casesDone: 1, casesPassed: 1 }
    const written: EvalRunListing = {
      runId: job.runId, dir: '/evals/x', modifiedAt: 2_000,
      record: {
        agent: { id: 'alpha', digest: `sha256:${'0'.repeat(64)}` }, mode: 'real', cases: [{ id: 'first', pass: true }, { id: 'second', pass: false }],
        turns: { total: 2, passed: 1 }, checks: { total: 2, passed: 1 }, startedAt: '2026-09-26T00:00:00.000Z', durationMs: 5,
      },
    }

    expect(studioEvalRunOf(job.runId, undefined, job)).toMatchObject({ status: 'interrupted', cases: { total: 2, done: 1 } })
    expect(studioEvalRunOf(job.runId, written, job)).toMatchObject({ status: 'failed', startedBy: 'root', cases: { total: 2, passed: 1, done: 2 } })
    expect(studioEvalRunOf(job.runId, { runId: job.runId, dir: '/evals/x', modifiedAt: 2_000 }, undefined).status).toBe('incomplete')
  })

  it('shows a run as running while its process lives, though it has written its run', () => {
    const written: EvalRunListing = {
      runId: RUNNING.runId, dir: '/evals/x', modifiedAt: 2_000,
      record: {
        agent: { id: 'alpha', digest: `sha256:${'0'.repeat(64)}` }, mode: 'real', cases: [{ id: 'first', pass: true }],
        turns: { total: 1, passed: 1 }, checks: { total: 1, passed: 1 }, startedAt: '2026-09-26T00:00:00.000Z', durationMs: 5,
      },
    }

    const run = studioEvalRunOf(RUNNING.runId, written, RUNNING)

    expect(run).toMatchObject({ status: 'running', cases: { total: 1, passed: 1 } })
  })

  it.skipIf(!existsSync('/proc/self/cmdline'))('lets a restarted Studio stop a run whose process outlived the one that started it (reads /proc)', async () => {
    const studioDir = lyteboatTempDir('studio-eval-jobs')
    const runId = '20260926T000000Z-beef'
    // A stand-in for the eval process: its command line names the run, and SIGINT ends it with the launcher's 130.
    const orphan = spawn(process.execPath, ['-e', 'process.on("SIGINT", () => process.exit(130)); process.stdout.write("ready"); setInterval(() => {}, 1000)', '--', '--run-id', runId], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] })
    const exited = new Promise<number | null>((resolve) => { orphan.on('exit', code => resolve(code)) })
    await new Promise((resolve) => { orphan.stdout.once('data', resolve) })
    mkdirSync(join(studioDir, 'eval-jobs'))
    writeFileSync(join(studioDir, 'eval-jobs', `${runId}.json`), JSON.stringify({ ...RUNNING, runId, pid: orphan.pid }))

    const jobs = new StudioEvalJobs(studioDir, undefined, () => {})
    await vi.waitFor(() => { expect(jobs.get(runId)?.status).toBe('running') })
    const stopped = jobs.stop(runId)

    expect(stopped).toMatchObject({ status: 'stopped', stopRequested: true })
    expect(await exited).toBe(130)
    expect(jobs.get(runId)?.status).toBe('stopped')
  })

  it('does not take a process the system gave the run\'s pid to since for the run', () => {
    const studioDir = lyteboatTempDir('studio-eval-jobs')
    mkdirSync(join(studioDir, 'eval-jobs'))
    // This test's own process: alive, but its command line names no run.
    writeFileSync(join(studioDir, 'eval-jobs', `${RUNNING.runId}.json`), JSON.stringify({ ...RUNNING, pid: process.pid }))

    const jobs = new StudioEvalJobs(studioDir, undefined, () => {})

    expect(jobs.get(RUNNING.runId)?.status).toBe('interrupted')
    expect(() => jobs.stop(RUNNING.runId)).toThrow('is not running')
  })
})
