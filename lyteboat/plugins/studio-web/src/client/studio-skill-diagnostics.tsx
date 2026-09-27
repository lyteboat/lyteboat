/**
 * A skill's diagnostics, laid out as the original Studio's panel: before a
 * run, what it checks and a Diagnose button; after one, when it ran and a
 * Re-run, every rule passed or failed, and the failed ones as a conflicts
 * table whose rows open onto their evidence and suggested fix. Only the
 * deterministic rules run; nothing here asks a model.
 * @module @lyteboat/studio-web/client/studio-skill-diagnostics
 */

import { useState } from 'react'
import type { StudioSkillDiagnosticsAnswer } from '@lyteboat/contracts/studio'
import { ChevronRightIcon } from './studio-icons.tsx'
import { formatStudioRelativeTime } from './studio-relative-time.ts'
import { studioWordedSkillFindings, type StudioWordedSkillFinding } from './studio-skill-finding-copy.ts'
import { toggledStudioSet } from './studio-toggled-set.ts'

type StudioFindingLevel = StudioWordedSkillFinding['level']

const STUDIO_FINDING_LEVEL_TONE: Record<StudioFindingLevel, string> = { error: 'error', warn: 'warning' }
const STUDIO_FINDING_LEVEL_ICON: Record<StudioFindingLevel, string> = { error: '!', warn: '△' }
const STUDIO_FINDING_LEVEL_LABEL: Record<StudioFindingLevel, string> = { error: 'Error', warn: 'Warn' }

/** The panel's controls: whether a run is under way, and the call that starts one. */
interface StudioDiagnosticsRun {
  running: boolean
  onDiagnose(): void
}

function StudioConflictRow({ finding, expanded, onToggle }: { finding: StudioWordedSkillFinding; expanded: boolean; onToggle(): void }) {
  const levelLabel = STUDIO_FINDING_LEVEL_LABEL[finding.level]
  return (
    <>
      <tr
        aria-expanded={expanded}
        className={`skill-diagnostics-conflict-row ${expanded ? 'expanded' : ''}`}
        onClick={onToggle}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          onToggle()
        }}
        role="button"
        tabIndex={0}
      >
        <td><ChevronRightIcon aria-hidden="true" className="skill-diagnostics-conflict-chevron" /></td>
        <td><span className="skill-diagnostics-judge rule">RULE</span></td>
        <td>
          <span aria-label={levelLabel} className={`skill-diagnostics-level-icon ${STUDIO_FINDING_LEVEL_TONE[finding.level]}`} title={levelLabel}>
            {STUDIO_FINDING_LEVEL_ICON[finding.level]}
          </span>
        </td>
        <td>{finding.rule}</td>
        <td>{finding.message}</td>
      </tr>
      {expanded && (
        <tr className="skill-diagnostics-conflict-detail-row">
          <td colSpan={5}>
            <div className="skill-diagnostics-conflict-detail">
              <div className="skill-diagnostics-conflict-evidence">
                <span className="skill-diagnostics-section-title">Evidence</span>
                <code>{finding.evidence ?? '-'}</code>
              </div>
              <div className="skill-diagnostics-conflict-fix">
                <span className="skill-diagnostics-section-title">Fix hint</span>
                <code>{finding.suggestion ?? '-'}</code>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

function StudioConflictsSection({ failed }: { failed: StudioWordedSkillFinding[] }) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const toggle = (ruleId: string): void => { setExpanded(previous => toggledStudioSet(previous, ruleId)) }
  if (failed.length === 0) {
    return (
      <div className="skill-diagnostics-section">
        <div className="skill-diagnostics-section-head">
          <span className="skill-diagnostics-section-title">CONFLICTS</span>
        </div>
        <div className="skill-diagnostics-compact-empty">
          <span aria-hidden="true" className="skill-diagnostics-status ok">✓</span>
          <span>No conflicts.</span>
        </div>
      </div>
    )
  }
  return (
    <div className="skill-diagnostics-section">
      <div className="skill-diagnostics-section-head">
        <span className="skill-diagnostics-section-title">CONFLICTS</span>
        <span className="skill-diagnostics-meta">{failed.length} items</span>
      </div>
      <div className="skill-diagnostics-table-wrap">
        <table className="skill-diagnostics-table">
          <thead>
            <tr>
              <th aria-label="Expand"></th>
              <th>Judge</th>
              <th>Level</th>
              <th>Type</th>
              <th>Conflict</th>
            </tr>
          </thead>
          <tbody>
            {failed.map(finding => (
              <StudioConflictRow expanded={expanded.has(finding.rule)} finding={finding} key={finding.rule} onToggle={() => toggle(finding.rule)} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function StudioDiagnosticsReport({ report, run }: { report: StudioSkillDiagnosticsAnswer; run: StudioDiagnosticsRun }) {
  const findings = studioWordedSkillFindings(report)
  const failed = findings.filter(finding => !finding.passed)
  return (
    <div className="skill-diagnostics-panel">
      <div className="skill-diagnostics-head">
        <div>
          <span className="skill-diagnostics-title">Diagnostics</span>
          <span className="skill-diagnostics-sub">deterministic rules · {formatStudioRelativeTime(report.generatedAt)}</span>
        </div>
        <div className="skill-diagnostics-actions">
          <button className="action-button skill-diagnostics-action" disabled={run.running} onClick={run.onDiagnose} type="button">
            {run.running ? 'Running...' : 'Re-run'}
          </button>
        </div>
      </div>

      <div className="skill-diagnostics-section">
        <div className="skill-diagnostics-section-head">
          <span className="skill-diagnostics-section-title">RULES</span>
          <span className="skill-diagnostics-meta">{findings.length - failed.length} ok · {failed.length} break</span>
        </div>
        <div className="skill-diagnostics-rule-list">
          {findings.map(finding => (
            <div className={`skill-diagnostics-rule ${finding.passed ? 'passed' : 'failed'}`} key={finding.rule}>
              <span aria-hidden="true" className={`skill-diagnostics-status ${finding.passed ? 'ok' : 'error'}`}>{finding.passed ? '✓' : '!'}</span>
              <div>
                <strong>{finding.label}</strong>
                <span>{finding.message}</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      <StudioConflictsSection failed={failed} />
    </div>
  )
}

/**
 * The Diagnostics tab of a skill's detail.
 * @param report - the last run's answer; null before the first.
 */
export function StudioSkillDiagnosticsPanel({ report, running, onDiagnose }: { report: StudioSkillDiagnosticsAnswer | null } & StudioDiagnosticsRun) {
  if (report === null) {
    return (
      <div className="skill-diagnostics-panel">
        <div className="skill-diagnostics-empty">
          <strong>No diagnostics yet.</strong>
          <span>Run deterministic checks against this SKILL, its tools, and workflow contracts.</span>
          <button className="action-button action-button-primary" disabled={running} onClick={onDiagnose} type="button">
            {running ? 'Diagnosing...' : 'Diagnose'}
          </button>
        </div>
      </div>
    )
  }
  // A new run is a new report: its conflicts open collapsed.
  return <StudioDiagnosticsReport key={report.generatedAt} report={report} run={{ running, onDiagnose }} />
}
