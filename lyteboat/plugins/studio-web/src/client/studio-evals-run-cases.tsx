/**
 * A run's results, as the original Studio's run detail draws them: the
 * per-case table (case, turns, first message, result with the turns passed,
 * the failing checks), filterable to the passed or the failed cases, each case
 * expanding into its turns — the message, what the turn showed (skill, tools,
 * cards, outcome, model requests, the answer text), and its checks (check,
 * expected, actual, pass) with the failed ones tinted; and the Run progress
 * card: the cases finished over the total on a bar, and a terminal-style line
 * per case result (tools called, verdict, first failing check). A run's
 * results exist once it is written, so a running run lists none yet.
 * @module @lyteboat/studio-web/client/studio-evals-run-cases
 */

import { Fragment, useMemo, useState } from 'react'
import type { LyteboatTurnOutcome } from '@lyteboat/contracts'
import type { StudioEvalCaseResult, StudioEvalRun, StudioEvalTurnResult } from '@lyteboat/contracts/studio'
import { formatStudioEvalTurnsPassed } from './studio-evals-format.ts'
import { StudioEvalsEmpty, StudioEvalsFilterChip, StudioEvalsStatusPill } from './studio-evals-primitives.tsx'
import { StudioEvalsChecksTable, StudioEvalsTurnBadge, StudioEvalsTurnConnector, StudioEvalsTurnGutter, StudioEvalsTurnUserEcho, StudioEvalsValue, StudioEvalsVerdictPill } from './studio-evals-turn-atoms.tsx'
import { CheckIcon, CloseIcon } from './studio-icons.tsx'

type StudioEvalsCaseFilter = 'all' | 'passed' | 'failed'

const STUDIO_EVAL_OUTCOME_PILL: Record<LyteboatTurnOutcome, string> = {
  completed: 'evals-pill-ok',
  rejected: 'evals-pill-warn',
  tool_stopped: 'evals-pill-info',
  stopped_by_limit: 'evals-pill-warn',
  aborted: 'evals-pill-warn',
  errored: 'evals-pill-err',
}
const STUDIO_EVAL_CASE_COLUMNS = 6
const STUDIO_EVAL_FAILING_SHOWN = 3

/** A case's failed checks; a multi-turn case names the turn (`T2/tools.called`). */
function studioEvalFailingChecks(result: StudioEvalCaseResult): string[] {
  const multi = result.turns.length > 1
  return result.turns.flatMap(turn => turn.checks.filter(check => !check.pass).map(check => multi ? `T${String(turn.turn)}/${check.check}` : check.check))
}

function studioEvalPassedTurns(result: StudioEvalCaseResult): number {
  return result.turns.filter(turn => turn.pass).length
}

function StudioEvalsObserved({ turn }: { turn: StudioEvalTurnResult }) {
  const { observed } = turn
  return (
    <dl className="evals-observed-grid">
      <dt>skill</dt>
      <dd>{observed.skill === null ? <span className="evals-muted evals-mono-sm">none</span> : <span className="evals-mono-sm">{observed.skill}</span>}</dd>
      <dt>tools</dt>
      <dd><StudioEvalsValue value={observed.tools} /></dd>
      <dt>cards</dt>
      <dd><StudioEvalsValue value={observed.cards} /></dd>
      <dt>outcome</dt>
      <dd><span className={`evals-pill ${STUDIO_EVAL_OUTCOME_PILL[observed.outcome]}`}>{observed.outcome}</span></dd>
      <dt>model requests</dt>
      <dd className="evals-mono-sm">{observed.modelRequests}</dd>
    </dl>
  )
}

function StudioEvalsTurnResultCard({ turn }: { turn: StudioEvalTurnResult }) {
  const passed = turn.checks.filter(check => check.pass).length
  return (
    <div className={`evals-turn-card evals-turn-card-${turn.pass ? 'pass' : 'fail'}`}>
      <StudioEvalsTurnGutter state={turn.pass ? 'pass' : 'fail'} turn={turn.turn} />
      <div className="evals-turn-body">
        <div className="evals-turn-section">
          <div className="evals-turn-section-head"><span className="evals-kicker">user</span></div>
          <StudioEvalsTurnUserEcho text={turn.message} />
        </div>
        <div className="evals-turn-section">
          <div className="evals-turn-section-head"><span className="evals-kicker">observed</span></div>
          <StudioEvalsObserved turn={turn} />
        </div>
        {turn.observed.text !== '' && (
          <div className="evals-turn-section">
            <div className="evals-turn-section-head"><span className="evals-kicker">assistant</span></div>
            <div className="evals-turn-assistant-body"><div className="evals-assistant-text">{turn.observed.text}</div></div>
          </div>
        )}
        <div className="evals-turn-section">
          <div className="evals-turn-section-head">
            <span className={`evals-kicker ${turn.pass ? 'evals-kicker-ok' : 'evals-kicker-err'}`}>checks<span className="evals-kicker-meta"> · {passed}/{turn.checks.length} passed</span></span>
          </div>
          <StudioEvalsChecksTable checks={turn.checks} />
        </div>
      </div>
    </div>
  )
}

function StudioEvalsCaseResultRow({ result, open, onToggle }: { result: StudioEvalCaseResult; open: boolean; onToggle(): void }) {
  const failing = studioEvalFailingChecks(result)
  const first = result.turns[0]?.message ?? ''
  return (
    <>
      <tr aria-expanded={open} className={`clickable ${open ? (result.pass ? 'evals-row-open' : 'evals-row-open-fail') : ''}`} onClick={onToggle}>
        <td className="evals-col-arrow"><span aria-hidden="true" className="evals-expand-arrow">{open ? '▼' : '▶'}</span></td>
        <td className="evals-tbl-cell-trunc evals-col-case"><span className="evals-mono-sm" title={result.caseId}>{result.caseId}</span></td>
        <td>{result.turns.length > 1 ? <StudioEvalsTurnBadge count={result.turns.length} /> : <span className="evals-muted">—</span>}</td>
        <td><div className="evals-query-cell" title={first}>{first === '' ? '(no input captured)' : first}</div></td>
        <td className="evals-nowrap"><StudioEvalsVerdictPill pass={result.pass} passedTurns={studioEvalPassedTurns(result)} turnCount={result.turns.length} /></td>
        <td>
          {failing.length === 0 ? <span className="evals-muted">—</span> : (
            <div className="evals-value-list">
              {failing.slice(0, STUDIO_EVAL_FAILING_SHOWN).map(check => <span className="evals-pill evals-pill-err evals-pill-xs" key={check}>{check}</span>)}
              {failing.length > STUDIO_EVAL_FAILING_SHOWN && <span className="evals-pill evals-pill-xs" title={failing.slice(STUDIO_EVAL_FAILING_SHOWN).join(', ')}>+{failing.length - STUDIO_EVAL_FAILING_SHOWN} more</span>}
            </div>
          )}
        </td>
      </tr>
      {open && (
        <tr className="evals-drawer-row">
          <td colSpan={STUDIO_EVAL_CASE_COLUMNS}>
            <div className="evals-case-drawer">
              {result.turns.map((turn, index) => (
                <Fragment key={turn.turn}>
                  {index > 0 && <StudioEvalsTurnConnector />}
                  <StudioEvalsTurnResultCard turn={turn} />
                </Fragment>
              ))}
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

/** The Per-case results surface of a run. */
export function StudioEvalsRunCases({ run, cases }: { run: StudioEvalRun; cases: readonly StudioEvalCaseResult[] }) {
  const [filter, setFilter] = useState<StudioEvalsCaseFilter>('all')
  const [openCase, setOpenCase] = useState<string | null>(null)
  const passed = cases.filter(result => result.pass).length
  const visible = useMemo(() => cases.filter(result => filter === 'all' || result.pass === (filter === 'passed')), [cases, filter])
  const emptyHint = cases.length > 0 ? 'No cases match this filter.' : run.status === 'running' ? 'Results appear when the run is written.' : 'No case results recorded.'
  return (
    <section aria-label="Per-case results" className="evals-surface evals-run-cases">
      <header className="evals-surface-head">
        <span className="evals-surface-head-title">Per-case results</span>
        <div className="evals-chip-row">
          <StudioEvalsFilterChip active={filter === 'all'} onClick={() => setFilter('all')}>All {cases.length}</StudioEvalsFilterChip>
          <StudioEvalsFilterChip active={filter === 'passed'} onClick={() => setFilter('passed')}><CheckIcon /> Passed {passed}</StudioEvalsFilterChip>
          <StudioEvalsFilterChip active={filter === 'failed'} onClick={() => setFilter('failed')}><CloseIcon /> Failed {cases.length - passed}</StudioEvalsFilterChip>
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
              <th>Result</th>
              <th>Failing checks</th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 && <tr><td colSpan={STUDIO_EVAL_CASE_COLUMNS}><StudioEvalsEmpty hint={emptyHint} /></td></tr>}
            {visible.map(result => (
              <StudioEvalsCaseResultRow key={result.caseId} onToggle={() => setOpenCase(current => current === result.caseId ? null : result.caseId)} open={openCase === result.caseId} result={result} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function StudioEvalsProgressLine({ result, index }: { result: StudioEvalCaseResult; index: number }) {
  const tools = result.turns.flatMap(turn => turn.observed.tools)
  const fail = studioEvalFailingChecks(result)[0]
  const suffix = formatStudioEvalTurnsPassed(studioEvalPassedTurns(result), result.turns.length)
  return (
    <div className={`evals-run-progress-term-line ${result.pass ? 'ok' : 'err'}`}>
      <span className="seq">{String(index + 1).padStart(3, '0')}</span>{' '}
      <span className="case-id" title={result.caseId}>{result.caseId}</span>{' '}
      <span className="chain">{tools.length === 0 ? '∅' : tools.join(' → ')}</span>{' '}
      <span className={`tag ${result.pass ? 'ok' : 'err'}`}>{result.pass ? `✓ pass${suffix}` : `✗ fail${suffix}`}</span>
      {!result.pass && fail !== undefined && <span className="fail-reason"> — {fail}</span>}
    </div>
  )
}

/** The Run progress card: the bar, and a line per case result. */
export function StudioEvalsRunProgress({ run, cases }: { run: StudioEvalRun; cases: readonly StudioEvalCaseResult[] }) {
  const running = run.status === 'running'
  const total = run.cases.total
  const done = running ? run.cases.done : Math.max(run.cases.done, cases.length)
  const pct = total === undefined || total === 0 ? (running ? 0 : 100) : Math.min(100, Math.round((done / total) * 100))
  return (
    <article className="evals-surface evals-run-progress">
      <header className="evals-surface-head">
        <span className="evals-surface-head-title">Run progress</span>
        <StudioEvalsStatusPill status={run.status} />
      </header>
      <div className="evals-run-progress-body">
        <div aria-valuemax={100} aria-valuemin={0} aria-valuenow={pct} className="evals-run-progress-bar" role="progressbar">
          <div className={`evals-run-progress-fill ${running ? 'running' : ''}`} style={{ width: `${String(pct)}%` }} />
        </div>
        <div className="evals-run-progress-meta">
          <span className="evals-mono-sm">{done}{total === undefined ? '' : ` / ${String(total)}`} cases</span>
          <span className="evals-muted evals-mono-sm">{pct}%</span>
        </div>
        <div aria-label="Per-case execution log" aria-live="polite" className="evals-run-progress-term" role="log">
          {cases.length === 0 && (
            <div className="evals-run-progress-term-line muted">
              <span className="prompt">$</span> {running ? `waiting for results… ${String(done)} case${done === 1 ? '' : 's'} finished` : 'no cases recorded'}
            </div>
          )}
          {cases.map((result, index) => <StudioEvalsProgressLine index={index} key={result.caseId} result={result} />)}
          {running && <div className="evals-run-progress-term-line cursor"><span className="prompt">$</span> <span className="blink">▍</span></div>}
        </div>
      </div>
    </article>
  )
}
