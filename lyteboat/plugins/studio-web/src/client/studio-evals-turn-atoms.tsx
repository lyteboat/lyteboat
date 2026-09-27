/**
 * The pieces every Evals page draws a turn with, as the original Studio's
 * turn atoms and expectation table draw them: a case's pass or fail pill with
 * the turns it passed, the turn card's gutter (number, verdict, foot label),
 * the read-only user echo, the connector between turns,
 * a check's name behind its group badge (behavior: skill, tools, model
 * requests; output: text and cards; flow: the outcome), a JSON value as the
 * tables show it, a request context as tags, the expectations of a case turn
 * (check → expected), the checks of a run turn (check, expected, actual,
 * pass), and the why-it-failed panel. Check names are the case file's paths,
 * as the eval runner names its checks (`tools.called`, `model_requests`, …).
 * @module @lyteboat/studio-web/client/studio-evals-turn-atoms
 */

import type { JsonValue } from '@lyteboat/contracts'
import type { StudioEvalCheck, StudioEvalExpect } from '@lyteboat/contracts/studio'
import { formatStudioEvalTurnsPassed } from './studio-evals-format.ts'
import { CheckIcon, CloseIcon } from './studio-icons.tsx'

type StudioEvalsCheckGroup = 'behavior' | 'output' | 'flow'

/** A turn's verdict on its card. */
type StudioEvalsTurnState = 'pass' | 'fail' | 'idle'

const STUDIO_EVAL_GROUP_LABEL: Record<StudioEvalsCheckGroup, string> = {
  behavior: 'Behavior — skill / tool calls / model requests',
  output: 'Output — answer text / cards',
  flow: 'Flow — how the turn ended',
}

function studioEvalCheckGroup(check: string): StudioEvalsCheckGroup {
  if (check === 'outcome') return 'flow'
  if (check.startsWith('text.') || check.startsWith('cards.')) return 'output'
  return 'behavior'
}

function StudioEvalsGroupGlyph({ group }: { group: StudioEvalsCheckGroup }) {
  if (group === 'behavior') {
    return <svg aria-hidden="true" fill="currentColor" height="12" viewBox="0 0 24 24" width="12"><path d="M13 2 4 14h6l-1 8 11-14h-7z" /></svg>
  }
  if (group === 'flow') {
    return (
      <svg aria-hidden="true" fill="none" height="12" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" viewBox="0 0 24 24" width="12">
        <circle cx="6" cy="6" r="2.5" />
        <circle cx="18" cy="6" r="2.5" />
        <circle cx="18" cy="18" r="2.5" />
        <path d="M8.5 6H15.5" />
        <path d="M18 8.5V15.5" />
      </svg>
    )
  }
  return <svg aria-hidden="true" fill="none" height="12" stroke="currentColor" strokeLinejoin="round" strokeWidth="2" viewBox="0 0 24 24" width="12"><path d="M4 5h16v11h-9l-4 4v-4H4z" /></svg>
}

/** A check's name behind its group badge. */
function StudioEvalsCheckName({ check }: { check: string }) {
  const group = studioEvalCheckGroup(check)
  return (
    <div className="evals-kind-cell">
      <span className={`evals-group-badge evals-group-${group}`} title={STUDIO_EVAL_GROUP_LABEL[group]}><StudioEvalsGroupGlyph group={group} /></span>
      <span className="evals-mono-sm">{check}</span>
    </div>
  )
}

function studioEvalScalarText(value: JsonValue): string {
  return typeof value === 'string' ? value : JSON.stringify(value)
}

/** A JSON value as the tables show it: a list as tags, an object as `key: value` pairs, a string on one line (whole in its title). */
export function StudioEvalsValue({ value }: { value: JsonValue }) {
  if (value === null) return <span className="evals-mono-sm evals-muted">null</span>
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="evals-mono-sm evals-muted">[]</span>
    return <span className="evals-value-list">{value.map((item, index) => <span className="evals-tag" key={`${String(index)}-${studioEvalScalarText(item)}`}>{studioEvalScalarText(item)}</span>)}</span>
  }
  if (typeof value === 'object') {
    const text = Object.entries(value).map(([key, item]) => `${key}: ${studioEvalScalarText(item)}`).join(' · ')
    return <span className="evals-mono-sm">{text}</span>
  }
  const text = String(value)
  return <span className="evals-mono-sm evals-value-text" title={text}>{text}</span>
}

/** A request context as `key: value` tags; nothing for none. */
export function StudioEvalsContextTags({ context }: { context: { [key: string]: JsonValue } | undefined }) {
  if (context === undefined || Object.keys(context).length === 0) return null
  return (
    <span className="evals-value-list">
      {Object.entries(context).map(([key, value]) => <span className="evals-tag" key={key} title={`${key}: ${studioEvalScalarText(value)}`}>{key}: {studioEvalScalarText(value)}</span>)}
    </span>
  )
}

/** A case's verdict: `✓ pass · 2/3` or `✗ fail`; `—` for a case the run does not have. */
export function StudioEvalsVerdictPill({ pass, passedTurns, turnCount }: { pass: boolean | null; passedTurns: number; turnCount: number }) {
  if (pass === null) return <span className="evals-muted">—</span>
  const suffix = formatStudioEvalTurnsPassed(passedTurns, turnCount)
  return pass
    ? <span className="evals-pill evals-pill-ok"><CheckIcon /> pass{suffix}</span>
    : <span className="evals-pill evals-pill-err"><CloseIcon /> fail{suffix}</span>
}

/** The `3 ≡` badge of a multi-turn case. */
export function StudioEvalsTurnBadge({ count }: { count: number }) {
  return (
    <span className="evals-turn-badge" title={`${String(count)} turn${count === 1 ? '' : 's'}`}>
      {count}<span aria-hidden="true" className="evals-turn-stack" />
    </span>
  )
}

/** The card's left column: the turn's number, its verdict, and a label. */
export function StudioEvalsTurnGutter({ state, turn }: { state: StudioEvalsTurnState; turn: number }) {
  return (
    <div className="evals-turn-gutter">
      <div className="evals-turn-gutter-num">{String(turn).padStart(2, '0')}</div>
      {state === 'pass' && <div className="evals-turn-gutter-mid">✓</div>}
      {state === 'fail' && <div className="evals-turn-gutter-mid">✗</div>}
      <div className="evals-turn-gutter-foot">{state === 'idle' ? 'turn' : state}</div>
    </div>
  )
}

/** The user's message, read only. */
export function StudioEvalsTurnUserEcho({ text }: { text: string }) {
  return <div className="evals-turn-user">{text === '' ? <span className="evals-muted">(no input)</span> : text}</div>
}

/** The slim line between two turn cards. */
export function StudioEvalsTurnConnector() {
  return <div aria-hidden="true" className="evals-turn-conn" />
}

/** The expectations of a case turn in the runner's order, one row per check it makes. */
function studioEvalExpectRows(expect: StudioEvalExpect): { check: string; expected: JsonValue }[] {
  const rows: { check: string; expected: JsonValue }[] = []
  if (expect.skill !== undefined) rows.push({ check: 'skill', expected: expect.skill })
  if (expect.tools?.called !== undefined) rows.push({ check: 'tools.called', expected: expect.tools.called })
  if (expect.tools?.not_called !== undefined) rows.push({ check: 'tools.not_called', expected: expect.tools.not_called })
  if (expect.cards?.areas !== undefined) rows.push({ check: 'cards.areas', expected: expect.cards.areas })
  if (expect.cards?.count !== undefined) rows.push({ check: 'cards.count', expected: expect.cards.count })
  if (expect.outcome !== undefined) rows.push({ check: 'outcome', expected: expect.outcome })
  if (expect.text?.includes !== undefined) rows.push({ check: 'text.includes', expected: expect.text.includes })
  if (expect.text?.excludes !== undefined) rows.push({ check: 'text.excludes', expected: expect.text.excludes })
  if (expect.text?.matches !== undefined) rows.push({ check: 'text.matches', expected: expect.text.matches })
  const requests = expect.model_requests
  if (requests !== undefined) {
    rows.push({ check: 'model_requests', expected: { ...requests.min === undefined ? {} : { min: requests.min }, ...requests.max === undefined ? {} : { max: requests.max } } })
  }
  return rows
}

/** How many checks a case turn makes. */
export function studioEvalExpectCount(expect: StudioEvalExpect): number {
  return studioEvalExpectRows(expect).length
}

/** A case turn's expectations: check → expected value. */
export function StudioEvalsExpectTable({ expect }: { expect: StudioEvalExpect }) {
  const rows = studioEvalExpectRows(expect)
  if (rows.length === 0) return <span className="evals-pill evals-pill-warn">no checks</span>
  return (
    <table className="evals-tbl evals-checks-tbl">
      <thead>
        <tr><th className="evals-col-check">Check</th><th>Expected</th></tr>
      </thead>
      <tbody>
        {rows.map(row => (
          <tr key={row.check}>
            <td><StudioEvalsCheckName check={row.check} /></td>
            <td><StudioEvalsValue value={row.expected} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** A run turn's checks: check, expected, actual, and pass; each row tinted by its result. */
export function StudioEvalsChecksTable({ checks }: { checks: readonly StudioEvalCheck[] }) {
  if (checks.length === 0) return <span className="evals-muted evals-mono-sm">no checks</span>
  return (
    <table className="evals-tbl evals-checks-tbl">
      <thead>
        <tr><th aria-label="Pass" className="evals-col-dot" /><th className="evals-col-check">Check</th><th>Expected</th><th>Actual</th></tr>
      </thead>
      <tbody>
        {checks.map(check => (
          <tr className={check.pass ? 'evals-check-row-pass' : 'evals-check-row-fail'} key={check.check}>
            <td className="evals-check-status-cell">
              <span className={`evals-check-dot ${check.pass ? 'evals-check-dot-pass' : 'evals-check-dot-fail'}`} title={check.pass ? 'pass' : 'fail'}>{check.pass ? '✓' : '✗'}</span>
            </td>
            <td><StudioEvalsCheckName check={check.check} /></td>
            <td><StudioEvalsValue value={check.expected} /></td>
            <td><StudioEvalsValue value={check.actual} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** The failing checks of one side, in the `└─ check` tree the original Studio uses; nothing when none failed. */
export function StudioEvalsFailPanel({ failures }: { failures: readonly string[] }) {
  if (failures.length === 0) return null
  return (
    <div className="evals-turn-section">
      <div className="evals-turn-section-head">
        <span className="evals-kicker evals-kicker-err">
          failing checks<span className="evals-kicker-meta"> · {failures.length}</span>
        </span>
      </div>
      <div className="evals-turn-fail-panel">
        {failures.map(failure => (
          <div className="evals-turn-fail-row" key={failure}>
            <span aria-hidden="true" className="evals-turn-fail-tree">└─</span>
            <div className="evals-turn-fail-content">
              <div className="evals-turn-fail-rule">{failure}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
