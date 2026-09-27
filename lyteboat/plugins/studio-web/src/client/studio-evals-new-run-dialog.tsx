/**
 * The New run dialog, as the original Studio's, trimmed to what an eval run
 * takes here: the mode, real (the default: the agent calls its model and the
 * sessions are recorded) or replay (a recorded real run played back without a
 * model), and for a replay the run to play back, one of this agent's real runs
 * that finished passed or failed, newest first. Launch starts the run over
 * every case; a refusal (another run already running, …) stays in the dialog.
 * The original's case-count choice, concurrency, judge model, profile, and
 * dataset have no counterpart in an eval run.
 * @module @lyteboat/studio-web/client/studio-evals-new-run-dialog
 */

import { useMemo, useState } from 'react'
import type { StudioEvalRun, StudioEvalRunRequest } from '@lyteboat/contracts/studio'
import { studioApi, studioErrorMessage } from './studio-api-client.ts'
import { StudioEvalsErrorCallout } from './studio-evals-primitives.tsx'
import { formatStudioEvalFraction, studioEvalRunWritten } from './studio-evals-format.ts'
import { PlayIcon } from './studio-icons.tsx'
import { formatStudioRelativeTime } from './studio-relative-time.ts'

type StudioEvalsRunMode = StudioEvalRunRequest['mode']

function studioEvalRunReplayable(run: StudioEvalRun): boolean {
  return run.mode === 'real' && studioEvalRunWritten(run)
}

/** The dialog over an agent's Runs; `onStarted` gets the run the Studio started. */
export function StudioEvalsNewRunDialog({ agentId, runs, onClose, onStarted }: {
  agentId: string
  runs: readonly StudioEvalRun[]
  onClose(): void
  onStarted(run: StudioEvalRun): void
}) {
  const recorded = useMemo(() => runs.filter(studioEvalRunReplayable), [runs])
  const [mode, setMode] = useState<StudioEvalsRunMode>('real')
  const [from, setFrom] = useState(recorded[0]?.runId ?? '')
  const [launching, setLaunching] = useState(false)
  const [refusal, setRefusal] = useState<string | null>(null)
  const ready = mode === 'real' || from !== ''

  const launch = async (): Promise<void> => {
    setLaunching(true)
    setRefusal(null)
    try {
      onStarted(await studioApi.startEvalRun(mode === 'real' ? { agentId, mode } : { agentId, mode, from }))
    } catch (error: unknown) {
      setRefusal(studioErrorMessage(error))
      setLaunching(false)
    }
  }

  return (
    <div className="evals-modal-scrim" onClick={onClose}>
      <div aria-labelledby="evals-new-run-title" aria-modal="true" className="evals-modal evals-new-run-modal" onClick={event => event.stopPropagation()} role="dialog">
        <div className="evals-modal-head">
          <h2 id="evals-new-run-title">New run</h2>
          <p>Run every eval case of <span className="evals-mono-sm">{agentId}</span>.</p>
        </div>
        <div className="evals-modal-body evals-modal-form">
          <label className="evals-field">
            <span className="evals-field-label">Mode</span>
            <select aria-label="Mode" className="evals-select" onChange={event => setMode(event.target.value === 'replay' ? 'replay' : 'real')} value={mode}>
              <option value="real">real — 调用模型，录制会话</option>
              <option value="replay">replay — 回放一次 real run，不调用模型</option>
            </select>
          </label>
          {mode === 'replay' && (
            <label className="evals-field">
              <span className="evals-field-label">From run</span>
              <select aria-label="From run" className="evals-select" disabled={recorded.length === 0} onChange={event => setFrom(event.target.value)} value={from}>
                {recorded.length === 0 && <option value="">No recorded real run</option>}
                {recorded.map(run => (
                  <option key={run.runId} value={run.runId}>
                    {run.runId} — {run.status} · {formatStudioEvalFraction(run.cases)} cases · {formatStudioRelativeTime(run.startedAt)}
                  </option>
                ))}
              </select>
              <span className="evals-field-hint">只能回放本 Agent 已结束（passed / failed）的 real run。</span>
            </label>
          )}
          {refusal !== null && <StudioEvalsErrorCallout label="Refused" message={refusal} />}
        </div>
        <div className="evals-modal-foot">
          <button className="btn" disabled={launching} onClick={onClose} type="button">Cancel</button>
          <button className="btn btn-accent" disabled={launching || !ready} onClick={() => void launch()} type="button">
            <PlayIcon /> {launching ? 'Launching…' : 'Launch Run'}
          </button>
        </div>
      </div>
    </div>
  )
}
