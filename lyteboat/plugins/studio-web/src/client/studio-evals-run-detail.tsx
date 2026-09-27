/**
 * One run at `/evals/:agentId/runs/:runId`, as the original Studio's run
 * detail: the head (breadcrumbs; the run id with its status; its mode, the
 * run a replay played back, the agent's version and short digest, the model,
 * when it started, how long it took, who started it; why it broke), the
 * actions (Stop while it runs, Rerun with the same agent, mode, source, and
 * cases, Delete after a confirmation — editors and admins; Export JSON, the
 * detail as read, for anyone), the pass-rate bar, the per-case results, and
 * the inspector (Run progress, the Summary of cases, turns, and checks). While
 * the run is running it is read again every two seconds until it is not. The
 * original's judge, scores, calibration, callback events, and trace steps have
 * no counterpart in an eval run.
 * @module @lyteboat/studio-web/client/studio-evals-run-detail
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import type { StudioEvalRun, StudioEvalRunDetail, StudioEvalRunRequest } from '@lyteboat/contracts/studio'
import { studioApi, studioErrorMessage } from './studio-api-client.ts'
import { canRunStudioEvals, useStudioAuth } from './studio-auth-context.tsx'
import { useStudioReading } from './studio-call-state.ts'
import { downloadStudioFile } from './studio-code-body.tsx'
import { useStudioConfirm } from './studio-confirm-dialog.tsx'
import { useStudioEvalsAgent } from './studio-evals-agent-scope.tsx'
import { formatStudioEvalDuration, formatStudioEvalFraction, formatStudioEvalPercent, studioEvalCaseResults, studioEvalModelLabel, studioEvalPassRate, studioEvalShortDigest, studioEvalTone } from './studio-evals-format.ts'
import { StudioEvalsCrumbs, StudioEvalsEmpty, StudioEvalsErrorCallout, StudioEvalsScoreBar, StudioEvalsStatusPill } from './studio-evals-primitives.tsx'
import { StudioEvalsRunCases, StudioEvalsRunProgress } from './studio-evals-run-cases.tsx'
import { DownloadIcon } from './studio-icons.tsx'
import { formatStudioRelativeTime } from './studio-relative-time.ts'
import { formatStudioSessionTime } from './studio-session-format.ts'

const STUDIO_EVAL_RUN_POLL_MS = 2000

function studioEvalRerunRequest(run: StudioEvalRun): StudioEvalRunRequest {
  return {
    agentId: run.agentId,
    mode: run.mode,
    ...run.from === undefined ? {} : { from: run.from },
    ...run.caseIds === undefined ? {} : { caseIds: run.caseIds },
  }
}

/** The run's detail, read on mount and every two seconds while it runs; the agent's list is read again once it stops running. */
function useStudioEvalRunDetail(runId: string): { detail: StudioEvalRunDetail | null; error: string | null; reload(): Promise<void> } {
  const { reloadRuns } = useStudioEvalsAgent()
  const { answer: detail, error, reload } = useStudioReading(useCallback(() => studioApi.evalRun(runId), [runId]))
  const sawRunning = useRef(false)

  const status = detail?.run.status
  useEffect(() => {
    if (status !== 'running') return undefined
    const timer = window.setInterval(() => void reload(), STUDIO_EVAL_RUN_POLL_MS)
    return () => window.clearInterval(timer)
  }, [status, reload])

  useEffect(() => {
    if (status === 'running') sawRunning.current = true
    else if (status !== undefined && sawRunning.current) {
      sawRunning.current = false
      void reloadRuns()
    }
  }, [status, reloadRuns])

  return { detail, error, reload }
}

/** Stop, Rerun, and Delete for the run shown, each reporting a refusal through `onError`. */
function useStudioEvalRunActions(run: StudioEvalRun, reload: () => Promise<void>, onError: (message: string | null) => void) {
  const { agentId, reloadRuns } = useStudioEvalsAgent()
  const navigate = useNavigate()
  const confirm = useStudioConfirm()
  const [busy, setBusy] = useState<'stop' | 'rerun' | 'delete' | null>(null)

  const act = async (kind: 'stop' | 'rerun' | 'delete', work: () => Promise<void>): Promise<void> => {
    setBusy(kind)
    onError(null)
    try {
      await work()
    } catch (error: unknown) {
      onError(studioErrorMessage(error))
    } finally {
      setBusy(null)
    }
  }
  const stop = (): Promise<void> => act('stop', async () => {
    await studioApi.stopEvalRun(run.runId)
    await Promise.all([reload(), reloadRuns()])
  })
  const rerun = (): Promise<void> => act('rerun', async () => {
    const next = await studioApi.startEvalRun(studioEvalRerunRequest(run))
    void reloadRuns()
    void navigate(`/evals/${agentId}/runs/${encodeURIComponent(next.runId)}`)
  })
  const remove = async (): Promise<void> => {
    if (!await confirm({ title: 'Delete run', message: `Delete run "${run.runId}"? This cannot be undone.`, tone: 'danger', confirmLabel: 'Delete' })) return
    await act('delete', async () => {
      await studioApi.deleteEvalRun(run.runId)
      await reloadRuns()
      void navigate(`/evals/${agentId}/runs`)
    })
  }
  return { busy, stop, rerun, remove }
}

/** The head's facts; one the run does not have yet (a running run's agent, model, and duration) or at all (who started a CLI run) is left out. */
function StudioEvalsRunMeta({ run, agentId }: { run: StudioEvalRun; agentId: string }) {
  const facts: { key: string; text: string; title?: string }[] = [
    ...run.agent === undefined ? [] : [{ key: 'agent', text: `agent ${run.agent.version === undefined ? '' : `v${run.agent.version} · `}${studioEvalShortDigest(run.agent.digest)}`, title: run.agent.digest }],
    ...run.model === undefined ? [] : [{ key: 'model', text: studioEvalModelLabel(run.model) }],
    { key: 'started', text: `ran ${formatStudioRelativeTime(run.startedAt)}`, title: formatStudioSessionTime(run.startedAt) },
    ...run.durationMs === undefined ? [] : [{ key: 'duration', text: `took ${formatStudioEvalDuration(run.durationMs)}` }],
    ...run.startedBy === undefined ? [] : [{ key: 'by', text: `by ${run.startedBy}` }],
  ]
  return (
    <span className="evals-detail-title-meta">
      <span className={`evals-pill ${run.mode === 'replay' ? 'evals-pill-accent' : ''}`}>{run.mode}</span>
      {run.from !== undefined && <Link className="evals-mono-sm" title="the run this replay played back" to={`/evals/${agentId}/runs/${encodeURIComponent(run.from)}`}>from {run.from}</Link>}
      {facts.map(fact => (
        <span className="evals-meta-fact" key={fact.key} title={fact.title}>
          <span className="sep">·</span>
          <span>{fact.text}</span>
        </span>
      ))}
    </span>
  )
}

function StudioEvalsRunHead({ detail, reload }: { detail: StudioEvalRunDetail; reload(): Promise<void> }) {
  const { run } = detail
  const { agentId } = useStudioEvalsAgent()
  const navigate = useNavigate()
  const { user } = useStudioAuth()
  const canRun = canRunStudioEvals(user?.role)
  const [actionError, setActionError] = useState<string | null>(null)
  const actions = useStudioEvalRunActions(run, reload, setActionError)
  const running = run.status === 'running'
  return (
    <div className="evals-detail-head">
      <StudioEvalsCrumbs items={[{ label: '← Runs', onClick: () => void navigate(`/evals/${agentId}/runs`) }, { label: run.runId }]} />
      <div className="evals-detail-title-row">
        <div className="evals-detail-title-copy">
          <h1 className="evals-detail-run-id">{run.runId}</h1>
          <StudioEvalsStatusPill status={run.status} />
          <StudioEvalsRunMeta agentId={agentId} run={run} />
        </div>
        <div className="evals-detail-actions">
          {canRun && running && (
            <button className="btn btn-sm evals-danger-text" disabled={actions.busy !== null} onClick={() => void actions.stop()} title="Stop the run; the cases it has not finished are not run." type="button">
              {actions.busy === 'stop' ? 'Stopping…' : 'Stop'}
            </button>
          )}
          {canRun && (
            <button className="btn btn-sm" disabled={actions.busy !== null || running} onClick={() => void actions.rerun()} title={running ? '等 run 结束后再重跑' : 'Run the same cases again, the same way'} type="button">
              {actions.busy === 'rerun' ? 'Starting…' : 'Rerun'}
            </button>
          )}
          <button className="btn btn-sm" onClick={() => downloadStudioFile(`${run.runId}.json`, `${JSON.stringify(detail, null, 2)}\n`, 'application/json')} title="Export this run's detail as JSON" type="button"><DownloadIcon /> Export JSON</button>
          {canRun && (
            <button className="btn btn-sm evals-danger-text" disabled={actions.busy !== null || running} onClick={() => void actions.remove()} title={running ? '运行中的 run 不能删除' : 'Delete run'} type="button">Delete</button>
          )}
        </div>
      </div>
      {run.error !== undefined && <StudioEvalsErrorCallout label="Run error" message={run.error} />}
      {actionError !== null && <StudioEvalsErrorCallout label="Refused" message={actionError} />}
    </div>
  )
}

/** A running run's pass rate is not known yet, so it shows none. */
function studioEvalSettledPassRate(run: StudioEvalRun): number | null {
  return run.status === 'running' ? null : studioEvalPassRate(run)
}

function StudioEvalsRunHero({ run, passed, failed }: { run: StudioEvalRun; passed: number; failed: number }) {
  const rate = studioEvalSettledPassRate(run)
  return (
    <section aria-label="Pass-rate summary" className="evals-surface evals-run-hero">
      <div className="evals-run-hero-score"><span className="evals-run-hero-score-num">{formatStudioEvalPercent(rate)}</span></div>
      <div className="evals-chip-row">
        <span className="evals-pill evals-pill-ok">✓ {passed}</span>
        <span className="evals-pill evals-pill-err">✗ {failed}</span>
        <span className="evals-pill">Σ {run.cases.total ?? '—'}</span>
      </div>
      <div className="evals-run-hero-spacer" />
      <span className="evals-mono-sm evals-muted">cases {formatStudioEvalFraction(studioEvalCaseResults(run))} · turns {formatStudioEvalFraction(run.turns)} · checks {formatStudioEvalFraction(run.checks)}</span>
    </section>
  )
}

function StudioEvalsSummaryRow({ label, figures }: { label: string; figures: { total?: number; passed: number } | undefined }) {
  const total = figures?.total
  return (
    <div className="evals-summary-row">
      <span className="evals-summary-key">{label}</span>
      <span className="evals-summary-val evals-summary-figure">
        <code className="evals-mono-sm">{formatStudioEvalFraction(figures)}</code>
        {figures !== undefined && total !== undefined && total > 0 && <StudioEvalsScoreBar tone={studioEvalTone(figures.passed / total)} value={figures.passed / total} />}
      </span>
    </div>
  )
}

function StudioEvalsRunSummary({ run }: { run: StudioEvalRun }) {
  return (
    <article className="evals-surface" data-testid="run-summary">
      <header className="evals-surface-head">
        <span className="evals-surface-head-title">Summary</span>
        <span className="evals-surface-head-meta">passed / total</span>
      </header>
      <div className="evals-summary-body">
        <StudioEvalsSummaryRow figures={studioEvalCaseResults(run)} label="cases" />
        <StudioEvalsSummaryRow figures={run.turns} label="turns" />
        <StudioEvalsSummaryRow figures={run.checks} label="checks" />
        <div className="evals-summary-row">
          <span className="evals-summary-key">pass rate</span>
          <span className="evals-summary-val"><code className="evals-mono-sm">{formatStudioEvalPercent(studioEvalSettledPassRate(run), 1)}</code></span>
        </div>
        <div className="evals-summary-row">
          <span className="evals-summary-key">cases asked</span>
          <span className="evals-summary-val">
            {run.caseIds === undefined ? <span className="evals-muted">all</span> : <span className="evals-value-list">{run.caseIds.map(caseId => <span className="evals-tag" key={caseId}>{caseId}</span>)}</span>}
          </span>
        </div>
      </div>
    </article>
  )
}

function StudioEvalsRunDetailView({ runId }: { runId: string }) {
  const { agentId } = useStudioEvalsAgent()
  const navigate = useNavigate()
  const { detail, error, reload } = useStudioEvalRunDetail(runId)

  if (detail === null) {
    return (
      <div className="evals-page">
        {error === null ? <StudioEvalsEmpty hint="Loading run…" /> : (
          <StudioEvalsEmpty hint={error} title="Run not found">
            <button className="btn btn-sm" onClick={() => void navigate(`/evals/${agentId}/runs`)} type="button">Back to Runs</button>
          </StudioEvalsEmpty>
        )}
      </div>
    )
  }
  const passed = detail.cases.filter(result => result.pass).length
  return (
    <div className="evals-page">
      <StudioEvalsRunHead detail={detail} reload={reload} />
      <div className="evals-run-body">
        <StudioEvalsRunHero failed={detail.cases.length - passed} passed={passed} run={detail.run} />
        {error !== null && <StudioEvalsErrorCallout label="Could not refresh" message={error} />}
        <div className="evals-run-grid">
          <StudioEvalsRunCases cases={detail.cases} run={detail.run} />
          <aside aria-label="Inspector" className="evals-inspector">
            <StudioEvalsRunProgress cases={detail.cases} run={detail.run} />
            <StudioEvalsRunSummary run={detail.run} />
          </aside>
        </div>
      </div>
    </div>
  )
}

/** The page at `/evals/:agentId/runs/:runId`; another run mounts a fresh view. */
export function StudioEvalsRunDetail() {
  const { runId } = useParams<{ runId: string }>()
  if (runId === undefined) return <StudioEvalsEmpty title="Run not found" />
  return <StudioEvalsRunDetailView key={runId} runId={runId} />
}
