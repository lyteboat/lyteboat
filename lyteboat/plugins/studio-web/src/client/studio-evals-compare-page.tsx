/**
 * Two runs side by side at `/evals/:agentId/compare?a=&b=`, as the original
 * Studio's compare page; A is the baseline. The head names both runs with the
 * A ⇄ B swap; the bar shows A's pass rate → B's, the change in points, and the
 * breakdown; its chips (declined, improved, unchanged pass or fail, only in A,
 * only in B) filter the per-case table (case, turns, first message, A and B
 * with the turns each passed, the turn they diverged at, how the case moved).
 * A case expands into each side's failing checks and the case's check
 * changes. The inspector holds both runs' figures and every check whose result
 * changed. Without both runs in the URL, the page offers a picker of two of
 * the agent's runs that finished passed or failed. The original's must-pass
 * gate has no counterpart.
 * @module @lyteboat/studio-web/client/studio-evals-compare-page
 */

import { useCallback, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import type { StudioEvalCompareAnswer, StudioEvalCompareCase, StudioEvalCompareStatus, StudioEvalRun } from '@lyteboat/contracts/studio'
import { studioApi } from './studio-api-client.ts'
import { useStudioCall } from './studio-call-state.ts'
import { useStudioEvalsAgent } from './studio-evals-agent-scope.tsx'
import { formatStudioEvalFraction, formatStudioEvalPercent, studioEvalPassRate, studioEvalRunWritten } from './studio-evals-format.ts'
import { StudioEvalsCrumbs, StudioEvalsEmpty, StudioEvalsFilterChip } from './studio-evals-primitives.tsx'
import { StudioEvalsFailPanel, StudioEvalsTurnBadge, StudioEvalsVerdictPill } from './studio-evals-turn-atoms.tsx'
import { formatStudioRelativeTime } from './studio-relative-time.ts'

type StudioEvalsCompareFilter = 'all' | StudioEvalCompareStatus
type StudioEvalsCheckChange = StudioEvalCompareAnswer['changes'][number]

const STUDIO_EVAL_COMPARE_STATUS: Record<StudioEvalCompareStatus, { label: string; pill: string }> = {
  improved: { label: '↑ Improved', pill: 'evals-pill-ok' },
  regressed: { label: '↓ Declined', pill: 'evals-pill-err' },
  unchanged_pass: { label: '= Pass', pill: '' },
  unchanged_fail: { label: '= Fail', pill: '' },
  only_a: { label: 'Only A', pill: '' },
  only_b: { label: 'Only B', pill: '' },
}
const STUDIO_EVAL_CHANGE_PILL: Record<StudioEvalsCheckChange['before'], string> = { pass: 'evals-pill-ok', fail: 'evals-pill-err', absent: '' }
const STUDIO_EVAL_COMPARE_COLUMNS = 8

function studioEvalCompareChips(answer: StudioEvalCompareAnswer): readonly (readonly [StudioEvalsCompareFilter, string])[] {
  const { breakdown } = answer
  return [
    ['all', `All ${String(answer.cases.length)}`],
    ['regressed', `↓ Declined ${String(breakdown.regressed)}`],
    ['improved', `↑ Improved ${String(breakdown.improved)}`],
    ['unchanged_pass', `= pass ${String(breakdown.unchangedPass)}`],
    ['unchanged_fail', `= fail ${String(breakdown.unchangedFail)}`],
    ['only_a', `Only A ${String(breakdown.onlyA)}`],
    ['only_b', `Only B ${String(breakdown.onlyB)}`],
  ]
}

function StudioEvalsCheckChangeRow({ change, showCase }: { change: StudioEvalsCheckChange; showCase: boolean }) {
  return (
    <div className="evals-check-change">
      <span className="evals-mono-sm evals-check-change-where">{showCase ? `${change.case} · ` : ''}T{change.turn} · {change.check}</span>
      <span className="evals-check-change-move">
        <span className={`evals-pill evals-pill-xs ${STUDIO_EVAL_CHANGE_PILL[change.before]}`}>{change.before}</span>
        <span className="evals-muted">→</span>
        <span className={`evals-pill evals-pill-xs ${STUDIO_EVAL_CHANGE_PILL[change.after]}`}>{change.after}</span>
      </span>
    </div>
  )
}

function StudioEvalsCompareSide({ label, pass, passedTurns, turnCount, failing }: { label: string; pass: boolean | null; passedTurns: number; turnCount: number; failing: readonly string[] }) {
  const state = pass === null ? 'idle' : pass ? 'pass' : 'fail'
  return (
    <div className={`evals-compare-side-mini evals-compare-side-mini-${state}`}>
      <div className="evals-compare-side-head">
        <span className="evals-kicker">{label}</span>
        <StudioEvalsVerdictPill pass={pass} passedTurns={passedTurns} turnCount={turnCount} />
      </div>
      {pass === null && <span className="evals-muted evals-side-absent">not in this run</span>}
      {pass !== null && failing.length === 0 && <span className="evals-muted evals-side-absent">every check passed</span>}
      <StudioEvalsFailPanel failures={failing} />
    </div>
  )
}

function StudioEvalsCompareCaseRow({ row, answer, open, onToggle }: { row: StudioEvalCompareCase; answer: StudioEvalCompareAnswer; open: boolean; onToggle(): void }) {
  const status = STUDIO_EVAL_COMPARE_STATUS[row.status]
  const changes = answer.changes.filter(change => change.case === row.caseId)
  const tint = row.status === 'improved' ? 'evals-row-open-ok' : row.status === 'regressed' ? 'evals-row-open-fail' : 'evals-row-open'
  return (
    <>
      <tr aria-expanded={open} className={`clickable ${open ? tint : ''}`} onClick={onToggle}>
        <td className="evals-col-arrow"><span aria-hidden="true" className="evals-expand-arrow">{open ? '▼' : '▶'}</span></td>
        <td className="evals-tbl-cell-trunc evals-col-case"><span className="evals-mono-sm" title={row.caseId}>{row.caseId}</span></td>
        <td>{row.turnCount > 1 ? <StudioEvalsTurnBadge count={row.turnCount} /> : <span className="evals-muted">—</span>}</td>
        <td><div className="evals-query-cell" title={row.message}>{row.message === '' ? '(no input)' : row.message}</div></td>
        <td className="evals-nowrap"><StudioEvalsVerdictPill pass={row.aPass} passedTurns={row.aPassedTurns} turnCount={row.turnCount} /></td>
        <td className="evals-nowrap"><StudioEvalsVerdictPill pass={row.bPass} passedTurns={row.bPassedTurns} turnCount={row.turnCount} /></td>
        <td>{row.divergedAtTurn > 0 ? <span className="evals-diverged-at">turn {row.divergedAtTurn}</span> : <span className="evals-muted">—</span>}</td>
        <td className="evals-nowrap"><span className={`evals-pill ${status.pill}`}>{status.label}</span></td>
      </tr>
      {open && (
        <tr className="evals-drawer-row">
          <td colSpan={STUDIO_EVAL_COMPARE_COLUMNS}>
            <div className="evals-case-drawer evals-compare-turns">
              <div className="evals-compare-pair">
                <StudioEvalsCompareSide failing={row.aFailingChecks} label={`A · ${answer.a.runId}`} pass={row.aPass} passedTurns={row.aPassedTurns} turnCount={row.turnCount} />
                <StudioEvalsCompareSide failing={row.bFailingChecks} label={`B · ${answer.b.runId}`} pass={row.bPass} passedTurns={row.bPassedTurns} turnCount={row.turnCount} />
              </div>
              {changes.length > 0 && (
                <div className="evals-compare-case-changes">
                  <span className="evals-kicker">check changes<span className="evals-kicker-meta"> · {changes.length}</span></span>
                  {changes.map(change => <StudioEvalsCheckChangeRow change={change} key={`${String(change.turn)}-${change.check}`} showCase={false} />)}
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

function StudioEvalsCompareHero({ answer }: { answer: StudioEvalCompareAnswer }) {
  const aRate = studioEvalPassRate(answer.a)
  const bRate = studioEvalPassRate(answer.b)
  const delta = aRate === null || bRate === null ? null : (bRate - aRate) * 100
  const tone = delta === null || Math.abs(delta) < 0.05 ? 'flat' : delta > 0 ? 'up' : 'down'
  return (
    <section aria-label="Comparison summary" className="evals-surface evals-run-hero">
      <div className="evals-run-hero-score">
        <span className="evals-run-hero-score-num">{formatStudioEvalPercent(aRate, 1)}</span>
        <span className="evals-run-hero-score-arrow">→</span>
        <span className={`evals-run-hero-score-cand ${tone}`}>{formatStudioEvalPercent(bRate, 1)}</span>
      </div>
      <span className={`evals-delta evals-delta-${tone}`}>{delta === null ? '—' : `${delta > 0 ? '+' : ''}${delta.toFixed(1)} pts`}</span>
      <div className="evals-chip-row">
        <span className="evals-pill evals-pill-ok">↑ {answer.breakdown.improved}</span>
        <span className="evals-pill evals-pill-err">↓ {answer.breakdown.regressed}</span>
        <span className="evals-pill">= pass {answer.breakdown.unchangedPass}</span>
        <span className="evals-pill">= fail {answer.breakdown.unchangedFail}</span>
      </div>
      <div className="evals-run-hero-spacer" />
    </section>
  )
}

function StudioEvalsCompareSideRows({ side, run }: { side: 'A' | 'B'; run: StudioEvalRun }) {
  return (
    <>
      <div className="evals-config-row"><span>{side} — run</span><span className="evals-mono-sm" title={run.runId}>{run.runId}</span></div>
      <div className="evals-config-row"><span>{side} — mode</span><span className="evals-mono-sm">{run.mode}{run.from === undefined ? '' : ` from ${run.from}`}</span></div>
      <div className="evals-config-row"><span>{side} — pass</span><span>{formatStudioEvalFraction(run.cases)} ({formatStudioEvalPercent(studioEvalPassRate(run), 1)})</span></div>
      <div className="evals-config-row"><span>{side} — started</span><span>{formatStudioRelativeTime(run.startedAt)}</span></div>
    </>
  )
}

function StudioEvalsCompareInspector({ answer }: { answer: StudioEvalCompareAnswer }) {
  return (
    <aside aria-label="Check-level diff" className="evals-inspector">
      <article className="evals-surface">
        <header className="evals-surface-head"><span className="evals-surface-head-title">Comparison sides</span></header>
        <div className="evals-config-rows">
          <StudioEvalsCompareSideRows run={answer.a} side="A" />
          <StudioEvalsCompareSideRows run={answer.b} side="B" />
        </div>
      </article>
      <article className="evals-surface" aria-label="Check-level changes">
        <header className="evals-surface-head">
          <span className="evals-surface-head-title">Check-level changes</span>
          <span className="evals-surface-head-meta">{answer.changes.length}</span>
        </header>
        <div className="evals-check-changes">
          {answer.changes.length === 0
            ? <span className="evals-muted">none</span>
            : answer.changes.map(change => <StudioEvalsCheckChangeRow change={change} key={`${change.case}-${String(change.turn)}-${change.check}`} showCase />)}
        </div>
      </article>
    </aside>
  )
}

function StudioEvalsCompareView({ a, b, onSwap, onPick }: { a: string; b: string; onSwap(): void; onPick(): void }) {
  const { agentId } = useStudioEvalsAgent()
  const navigate = useNavigate()
  const { answer, error } = useStudioCall(useCallback(() => studioApi.compareEvalRuns(a, b), [a, b]))
  const [filter, setFilter] = useState<StudioEvalsCompareFilter>('all')
  const [openCase, setOpenCase] = useState<string | null>(null)
  const visible = useMemo(() => (answer?.cases ?? []).filter(row => filter === 'all' || row.status === filter), [answer, filter])
  const back = (): void => { void navigate(`/evals/${agentId}/runs`) }

  if (error !== null) {
    return (
      <div className="evals-page">
        <StudioEvalsEmpty hint={error} title="Compare failed">
          <div className="evals-chip-row">
            <button className="btn btn-sm" onClick={back} type="button">Back to Runs</button>
            <button className="btn btn-sm" onClick={onPick} type="button">Pick other runs</button>
          </div>
        </StudioEvalsEmpty>
      </div>
    )
  }
  if (answer === null) return <div className="evals-page"><StudioEvalsEmpty hint="Loading comparison…" /></div>
  return (
    <div className="evals-page">
      <div className="evals-detail-head">
        <StudioEvalsCrumbs items={[{ label: '← Runs', onClick: back }, { label: `Compare ${answer.a.runId} vs ${answer.b.runId}` }]} />
        <div className="evals-detail-title-row">
          <div className="evals-detail-title-copy">
            <h1 className="evals-detail-run-id">{answer.a.runId}<span className="evals-title-vs">vs</span>{answer.b.runId}</h1>
          </div>
          <div className="evals-detail-actions">
            <button className="btn btn-sm" onClick={onSwap} title="Swap A and B sides" type="button">A ⇄ B</button>
          </div>
        </div>
      </div>
      <div className="evals-run-body">
        <StudioEvalsCompareHero answer={answer} />
        <div className="evals-run-grid">
          <section aria-label="Per-case comparison" className="evals-surface evals-run-cases">
            <header className="evals-surface-head">
              <span className="evals-surface-head-title">Per-case comparison</span>
              <div className="evals-chip-row">
                {studioEvalCompareChips(answer).map(([item, label]) => <StudioEvalsFilterChip active={filter === item} key={item} onClick={() => setFilter(item)}>{label}</StudioEvalsFilterChip>)}
              </div>
            </header>
            <div className="evals-list-scroll">
              <table className="evals-tbl">
                <thead>
                  <tr>
                    <th aria-label="Expand" className="evals-col-arrow" />
                    <th className="evals-col-case">Case ID</th>
                    <th>Turns</th>
                    <th>Query</th>
                    <th title={answer.a.runId}>A</th>
                    <th title={answer.b.runId}>B</th>
                    <th>Diverged at</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.length === 0 && <tr><td colSpan={STUDIO_EVAL_COMPARE_COLUMNS}><StudioEvalsEmpty hint="No cases match this filter." /></td></tr>}
                  {visible.map(row => <StudioEvalsCompareCaseRow answer={answer} key={row.caseId} onToggle={() => setOpenCase(current => current === row.caseId ? null : row.caseId)} open={openCase === row.caseId} row={row} />)}
                </tbody>
              </table>
            </div>
          </section>
          <StudioEvalsCompareInspector answer={answer} />
        </div>
      </div>
    </div>
  )
}

/** Two selects over the agent's runs with results (passed or failed, newest first), B defaulting to the newest and A to the one before it. */
function StudioEvalsComparePicker({ runs, onPick }: { runs: readonly StudioEvalRun[]; onPick(a: string, b: string): void }) {
  const finished = useMemo(() => runs.filter(studioEvalRunWritten), [runs])
  const [a, setA] = useState(finished[1]?.runId ?? '')
  const [b, setB] = useState(finished[0]?.runId ?? '')
  const option = (run: StudioEvalRun) => <option key={run.runId} value={run.runId}>{run.runId} — {run.mode} · {run.status} · {formatStudioRelativeTime(run.startedAt)}</option>
  return (
    <div className="evals-page">
      <div className="evals-compare-picker">
        <section aria-label="Pick two runs" className="evals-surface">
          <header className="evals-surface-head"><span className="evals-surface-head-title">Compare two runs</span></header>
          <div className="evals-modal-form">
            <label className="evals-field">
              <span className="evals-field-label">A — baseline</span>
              <select aria-label="Run A" className="evals-select" onChange={event => setA(event.target.value)} value={a}>
                <option value="">Pick a run</option>
                {finished.map(option)}
              </select>
            </label>
            <label className="evals-field">
              <span className="evals-field-label">B — compared with A</span>
              <select aria-label="Run B" className="evals-select" onChange={event => setB(event.target.value)} value={b}>
                <option value="">Pick a run</option>
                {finished.map(option)}
              </select>
            </label>
            <div className="evals-compare-picker-foot">
              <button className="btn btn-sm btn-accent" disabled={a === '' || b === '' || a === b} onClick={() => onPick(a, b)} type="button">Compare</button>
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}

/** The page at `/evals/:agentId/compare`. */
export function StudioEvalsComparePage() {
  const { runs } = useStudioEvalsAgent()
  const [search, setSearch] = useSearchParams()
  const a = search.get('a') ?? ''
  const b = search.get('b') ?? ''
  if (a === '' || b === '') {
    if (runs === null) return <div className="evals-page"><StudioEvalsEmpty hint="Loading runs…" /></div>
    return <StudioEvalsComparePicker onPick={(nextA, nextB) => setSearch({ a: nextA, b: nextB })} runs={runs} />
  }
  return <StudioEvalsCompareView a={a} b={b} key={`${a}\n${b}`} onPick={() => setSearch({})} onSwap={() => setSearch({ a: b, b: a }, { replace: true })} />
}
