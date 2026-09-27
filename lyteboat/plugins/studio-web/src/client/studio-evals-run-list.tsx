/**
 * An agent's Runs, as the original Studio's runs table: one row per run
 * (id, mode and the run a replay played back, status, pass rate as cases
 * passed over their total, cases · turns · checks, agent version, model,
 * started, duration, who started it), filter chips by status and a text
 * filter, 25 to 100 rows a page. Checking rows swaps the head for the
 * selection bar: Compare opens exactly two runs that finished passed or
 * failed (the others have no results) side by side, the older as the
 * baseline; Delete (editors and admins, after a confirmation) removes them. A running run shows its finished cases on a moving bar and can be
 * neither compared nor deleted; while one is listed, the list is read again
 * every two seconds.
 * @module @lyteboat/studio-web/client/studio-evals-run-list
 */

import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { StudioEvalRun, StudioEvalRunStatus } from '@lyteboat/contracts/studio'
import { studioApi, studioErrorMessage } from './studio-api-client.ts'
import { useStudioConfirm } from './studio-confirm-dialog.tsx'
import { useStudioEvalsAgent } from './studio-evals-agent-scope.tsx'
import { formatStudioEvalDuration, formatStudioEvalFraction, studioEvalCaseResults, studioEvalModelLabel, studioEvalPassRate, studioEvalRunWritten, studioEvalShortDigest, studioEvalTone } from './studio-evals-format.ts'
import { StudioEvalsEmpty, StudioEvalsErrorCallout, StudioEvalsFilterChip, StudioEvalsModePill, StudioEvalsPagination, StudioEvalsProgressBar, StudioEvalsScoreBar, StudioEvalsStatusPill } from './studio-evals-primitives.tsx'
import { CloseIcon, SearchIcon } from './studio-icons.tsx'
import { formatStudioRelativeTime } from './studio-relative-time.ts'
import { formatStudioSessionTime } from './studio-session-format.ts'
import { studioTextMatches } from './studio-text-filter.ts'
import { toggledStudioSet } from './studio-toggled-set.ts'

type StudioEvalsRunFilter = 'all' | 'passed' | 'failed' | 'running' | 'unfinished'

const STUDIO_EVAL_RUN_FILTERS: readonly (readonly [StudioEvalsRunFilter, string])[] = [
  ['all', 'All'], ['passed', 'Passed'], ['failed', 'Failed'], ['running', 'Running'], ['unfinished', 'Unfinished'],
]
const STUDIO_EVAL_RUN_FILTER_OF: Record<StudioEvalRunStatus, StudioEvalsRunFilter> = {
  running: 'running',
  passed: 'passed',
  failed: 'failed',
  error: 'unfinished',
  stopped: 'unfinished',
  interrupted: 'unfinished',
  incomplete: 'unfinished',
}
const STUDIO_EVAL_RUNS_POLL_MS = 2000
const STUDIO_EVAL_RUNNING_LOCK = '运行中的 run 不能对比或删除'

/** A run's searchable facts as one text, so a filter may span two of them (`real passed`). */
function studioEvalRunText(run: StudioEvalRun): string {
  return [run.runId, run.mode, run.status, run.from ?? '', run.startedBy ?? '', run.agent?.version ?? '', studioEvalModelLabel(run.model), ...run.caseIds ?? []].join(' ')
}

function StudioEvalsRunPassCell({ run }: { run: StudioEvalRun }) {
  if (run.status === 'running') return <StudioEvalsProgressBar done={run.cases.done} total={run.cases.total} />
  const rate = studioEvalPassRate(run)
  return rate === null ? <span className="evals-muted">—</span> : <StudioEvalsScoreBar tone={studioEvalTone(rate)} value={rate} />
}

function StudioEvalsRunRow({ run, selected, canRun, onToggle, onOpen, onDelete }: {
  run: StudioEvalRun
  selected: boolean
  canRun: boolean
  onToggle(): void
  onOpen(): void
  onDelete(): void
}) {
  const running = run.status === 'running'
  return (
    <tr className={`clickable ${selected ? 'row-selected' : ''}`} onClick={onOpen}>
      <td onClick={event => event.stopPropagation()}>
        <input aria-label={`Select run ${run.runId}`} checked={selected} disabled={running} onChange={onToggle} title={running ? STUDIO_EVAL_RUNNING_LOCK : undefined} type="checkbox" />
      </td>
      <td>
        <div className="evals-cell-stack">
          <span className="evals-mono-sm evals-nowrap">{run.runId}</span>
          {run.caseIds !== undefined && <span className="evals-mono-sm evals-muted" title={run.caseIds.join(', ')}>{run.caseIds.length} case{run.caseIds.length === 1 ? '' : 's'} only</span>}
        </div>
      </td>
      <td><StudioEvalsModePill run={run} /></td>
      <td><StudioEvalsStatusPill status={run.status} /></td>
      <td><StudioEvalsRunPassCell run={run} /></td>
      <td className="evals-mono-sm evals-nowrap">{formatStudioEvalFraction(studioEvalCaseResults(run))} · {formatStudioEvalFraction(run.turns)} · {formatStudioEvalFraction(run.checks)}</td>
      <td title={run.agent?.digest}>
        {run.agent === undefined ? <span className="evals-muted">—</span> : (
          <div className="evals-cell-stack">
            <span className="evals-mono-sm">{run.agent.version === undefined ? '未标版本' : `v${run.agent.version}`}</span>
            <span className="evals-mono-sm evals-muted">{studioEvalShortDigest(run.agent.digest)}</span>
          </div>
        )}
      </td>
      <td className="evals-mono-sm">{studioEvalModelLabel(run.model)}</td>
      <td className="evals-nowrap" title={formatStudioSessionTime(run.startedAt)}>
        <div className="evals-cell-stack">
          <span className="evals-mono-sm">{formatStudioRelativeTime(run.startedAt)}</span>
          <span className="evals-mono-sm evals-muted">{run.durationMs === undefined ? '—' : `took ${formatStudioEvalDuration(run.durationMs)}`}</span>
        </div>
      </td>
      <td className="evals-mono-sm">{run.startedBy ?? '—'}</td>
      <td onClick={event => event.stopPropagation()}>
        {canRun && !running && (
          <button aria-label={`Delete run ${run.runId}`} className="btn btn-sm btn-ghost evals-danger-text" onClick={onDelete} title="Delete run" type="button"><CloseIcon /></button>
        )}
      </td>
    </tr>
  )
}

function StudioEvalsRunSelectionBar({ count, canCompare, canRun, onCompare, onDelete, onClear }: {
  count: number
  canCompare: boolean
  canRun: boolean
  onCompare(): void
  onDelete(): void
  onClear(): void
}) {
  return (
    <div className="evals-list-selection">
      <span className="evals-selection-count">{count} selected</span>
      <button className="btn btn-sm btn-accent" disabled={!canCompare} onClick={onCompare} title={canCompare ? 'Compare these two runs side-by-side' : '选两个已写出结果（passed / failed）的 run 才能对比'} type="button">Compare 2 runs</button>
      {canRun && <button className="btn btn-sm evals-danger-text" onClick={onDelete} type="button">Delete</button>}
      <button className="btn btn-sm btn-ghost" onClick={onClear} type="button">Clear</button>
    </div>
  )
}

function StudioEvalsRunFilterBar({ runs, filter, text, onFilter, onText }: {
  runs: readonly StudioEvalRun[]
  filter: StudioEvalsRunFilter
  text: string
  onFilter(filter: StudioEvalsRunFilter): void
  onText(text: string): void
}) {
  const count = (item: StudioEvalsRunFilter): number => item === 'all' ? runs.length : runs.filter(run => STUDIO_EVAL_RUN_FILTER_OF[run.status] === item).length
  return (
    <>
      <div className="evals-chip-row">
        {STUDIO_EVAL_RUN_FILTERS.map(([item, label]) => (
          <StudioEvalsFilterChip active={filter === item} key={item} onClick={() => onFilter(item)}>{label} {count(item)}</StudioEvalsFilterChip>
        ))}
      </div>
      <label className="evals-input evals-list-filter">
        <SearchIcon />
        <input aria-label="Filter runs" onChange={event => onText(event.target.value)} placeholder="Filter…" value={text} />
      </label>
    </>
  )
}

/** Delete runs one by one; the ids that could not be deleted, each with why. */
async function deleteStudioEvalRuns(runIds: readonly string[]): Promise<string[]> {
  const failures: string[] = []
  for (const runId of runIds) {
    try {
      await studioApi.deleteEvalRun(runId)
    } catch (error: unknown) {
      failures.push(`${runId}: ${studioErrorMessage(error)}`)
    }
  }
  return failures
}

/** The Runs tab's list. */
export function StudioEvalsRunList({ canRun }: { canRun: boolean }) {
  const { agentId, runs, reloadRuns } = useStudioEvalsAgent()
  const navigate = useNavigate()
  const confirm = useStudioConfirm()
  const [filter, setFilter] = useState<StudioEvalsRunFilter>('all')
  const [text, setText] = useState('')
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
  const [page, setPage] = useState(1)
  const [perPage, setPerPage] = useState(25)
  const [failure, setFailure] = useState<string | null>(null)
  const all = useMemo(() => runs ?? [], [runs])
  const anyRunning = all.some(run => run.status === 'running')

  useEffect(() => {
    if (!anyRunning) return undefined
    const timer = window.setInterval(() => void reloadRuns(), STUDIO_EVAL_RUNS_POLL_MS)
    return () => window.clearInterval(timer)
  }, [anyRunning, reloadRuns])

  const visible = useMemo(() => all.filter(run => (filter === 'all' || STUDIO_EVAL_RUN_FILTER_OF[run.status] === filter) && studioTextMatches(text, [studioEvalRunText(run)])), [all, filter, text])
  const pages = Math.max(1, Math.ceil(visible.length / perPage))
  const current = Math.min(page, pages)
  const paged = visible.slice((current - 1) * perPage, current * perPage)
  const chosen = all.filter(run => selected.has(run.runId) && run.status !== 'running')
  const selectable = paged.filter(run => run.status !== 'running')
  const allChecked = selectable.length > 0 && selectable.every(run => selected.has(run.runId))

  if (runs === null) return <div className="evals-list-page"><StudioEvalsEmpty hint="Loading runs…" /></div>
  if (all.length === 0) return <div className="evals-list-page"><StudioEvalsEmpty hint={canRun ? 'Click New Run to run this agent\'s eval cases.' : 'Runs show up here when an editor starts one, or when lyteboat eval writes one.'} title="No runs yet" /></div>

  const toggle = (runId: string): void => { setSelected(previous => toggledStudioSet(previous, runId)) }
  const toggleAll = (): void => {
    setSelected(previous => {
      const next = new Set(previous)
      for (const run of selectable) {
        if (allChecked) next.delete(run.runId)
        else next.add(run.runId)
      }
      return next
    })
  }
  const compare = (): void => {
    const [older, newer] = [...chosen].sort((a, b) => a.startedAt - b.startedAt)
    if (older === undefined || newer === undefined) return
    void navigate(`/evals/${agentId}/compare?a=${encodeURIComponent(older.runId)}&b=${encodeURIComponent(newer.runId)}`)
  }
  const remove = async (runIds: readonly string[]): Promise<void> => {
    const confirmed = await confirm({
      title: runIds.length === 1 ? 'Delete run' : 'Delete runs',
      message: runIds.length === 1 ? `Delete run "${runIds[0] ?? ''}"? This cannot be undone.` : `Delete ${String(runIds.length)} runs? This cannot be undone.`,
      tone: 'danger',
      confirmLabel: 'Delete',
    })
    if (!confirmed) return
    const failures = await deleteStudioEvalRuns(runIds)
    setSelected(new Set())
    setFailure(failures.length === 0 ? null : `${String(failures.length)} 条 run 删除失败 — ${failures.join('; ')}`)
    await reloadRuns()
  }

  return (
    <div className="evals-list-page">
      <div className="evals-list-head">
        {chosen.length === 0
          ? <StudioEvalsRunFilterBar filter={filter} onFilter={item => { setFilter(item); setPage(1) }} onText={value => { setText(value); setPage(1) }} runs={all} text={text} />
          : <StudioEvalsRunSelectionBar canCompare={chosen.length === 2 && chosen.every(studioEvalRunWritten)} canRun={canRun} count={chosen.length} onClear={() => setSelected(new Set())} onCompare={compare} onDelete={() => void remove(chosen.map(run => run.runId))} />}
      </div>
      {failure !== null && <StudioEvalsErrorCallout label="Delete" message={failure} />}
      <div className="evals-list-body">
        <div className="evals-list-scroll">
          <table className="evals-tbl evals-runs-tbl">
            <thead>
              <tr>
                <th className="evals-col-check-box"><input aria-label="Select all visible runs" checked={allChecked} disabled={selectable.length === 0} onChange={toggleAll} type="checkbox" /></th>
                <th>Run</th>
                <th>Mode</th>
                <th>Status</th>
                <th>Pass-rate</th>
                <th title="passed/total">Cases · Turns · Checks</th>
                <th>Agent</th>
                <th>Model</th>
                <th title="started · duration">Started</th>
                <th>By</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {paged.map(run => (
                <StudioEvalsRunRow
                  canRun={canRun}
                  key={run.runId}
                  onDelete={() => void remove([run.runId])}
                  onOpen={() => void navigate(`/evals/${agentId}/runs/${encodeURIComponent(run.runId)}`)}
                  onToggle={() => toggle(run.runId)}
                  run={run}
                  selected={selected.has(run.runId)}
                />
              ))}
              {visible.length === 0 && <tr><td colSpan={11}><StudioEvalsEmpty hint="Try a different filter." title="No runs match the filter" /></td></tr>}
            </tbody>
          </table>
        </div>
        <StudioEvalsPagination onPage={setPage} onPerPage={size => { setPerPage(size); setPage(1) }} page={current} perPage={perPage} total={visible.length} />
      </div>
    </div>
  )
}
