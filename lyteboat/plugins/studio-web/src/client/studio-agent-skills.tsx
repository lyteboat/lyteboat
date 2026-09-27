/**
 * An agent's Skills, laid out as the original Studio's: the searchable,
 * collapsible list of the agent's skills (who may invoke each, whether its
 * metadata is broken) beside the selected skill's detail: its SKILL.md and its
 * deterministic diagnostics. An admin can hot-fix a skill that has a file: the
 * whole SKILL.md in an editor, saved against the version read (`If-Match`),
 * after a warning when the agent has a release lock the change will depart
 * from; a save refreshes the radar. The selection is the URL's
 * `?skill=<name>` (else the first skill), so a link opens a skill.
 * @module @lyteboat/studio-web/client/studio-agent-skills
 */

import { useCallback, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { StudioAgent, StudioSkillDetail, StudioSkillDiagnosticsAnswer, StudioSkillSummary } from '@lyteboat/contracts/studio'
import { studioApi, studioErrorCode, studioErrorMessage } from './studio-api-client.ts'
import { useStudioAuth } from './studio-auth-context.tsx'
import { useStudioCall } from './studio-call-state.ts'
import { StudioCodeBody } from './studio-code-body.tsx'
import { StudioCollapsedRail, StudioRailToggle, useStudioRailCollapse } from './studio-collapsible-rail.tsx'
import { useStudioConfirm } from './studio-confirm-dialog.tsx'
import { formatStudioRelativeTime } from './studio-relative-time.ts'
import { StudioSearchBox } from './studio-search-box.tsx'
import { useStudioShell } from './studio-shell.tsx'
import { StudioSkillDiagnosticsPanel } from './studio-skill-diagnostics.tsx'
import { studioTextMatches } from './studio-text-filter.ts'

type StudioSkillDetailTab = 'skill' | 'diagnostics'

/** The banner over a skill's detail. */
interface StudioSkillFeedback {
  text: string
  error: boolean
}

/** A hot-fix under way: the text being edited and the version of the file it replaces. */
interface StudioSkillHotFix {
  draft: string
  sha256: string
}

const STUDIO_SKILL_SAVED = '已保存，并写入审计记录。'
const STUDIO_SKILL_CHANGED_SINCE_READ = '文件在你打开之后被改过，请重新加载后再改。'

function studioSkillInvocation(skill: StudioSkillSummary): string {
  if (skill.modelInvocable && skill.userInvocable) return 'model+user'
  if (skill.modelInvocable) return 'model'
  if (skill.userInvocable) return 'user'
  return 'none'
}

function studioHotFixWarning(releaseVersion: string): string {
  return `这个 agent 有发布锁（v${releaseVersion}）。保存后目录内容与锁不同：雷达显示「偏离发布」，按锁上线的 serve 重启时会拒绝它。技能正文在 serve 里下次调用时生效，名称和描述要等 serve 重启。这次修改会写进审计记录。`
}

/** What a hot-fix of this skill starts from; null when it has no file to replace. */
function studioHotFixSource(detail: StudioSkillDetail): StudioSkillHotFix | null {
  return detail.file !== undefined && detail.sha256 !== undefined ? { draft: detail.file, sha256: detail.sha256 } : null
}

function StudioSkillRail({ skills, query, setQuery, selectedName, onSelect, onCollapse }: {
  skills: StudioSkillSummary[]
  query: string
  setQuery(query: string): void
  selectedName: string | undefined
  onSelect(name: string): void
  onCollapse(): void
}) {
  const shown = useMemo(() => skills.filter(skill => studioTextMatches(query, [skill.name, skill.description, skill.path ?? '', ...skill.requiredTools])), [query, skills])
  return (
    <div className="workspace-surface split-list">
      <div className="surface-heading">
        <span>Skills</span>
        <span className="surface-heading-trail">
          <span>{skills.length}</span>
          <StudioRailToggle label="Collapse skills" onToggle={onCollapse} />
        </span>
      </div>
      <StudioSearchBox label="Search skills" onChange={setQuery} placeholder="Search skills" value={query} />
      <div className="document-list">
        {shown.map(skill => (
          <button className={`document-card document-button skill-list-card ${selectedName === skill.name ? 'active' : ''}`} key={skill.name} onClick={() => onSelect(skill.name)} type="button">
            <div className="skill-list-card-top">
              <strong>{skill.name}</strong>
              <span className="skill-policy-chip">{studioSkillInvocation(skill)}</span>
            </div>
            <p>{skill.description || skill.path}</p>
            {skill.metadataProblem !== undefined && <span className="badge err" title={skill.metadataProblem}>元数据无效</span>}
          </button>
        ))}
        {skills.length === 0 && <div className="empty-surface">No skills found.</div>}
        {skills.length > 0 && shown.length === 0 && <div className="empty-surface">No matching skills.</div>}
      </div>
    </div>
  )
}

function StudioSkillEditor({ hotFix, saving, onChange, onSave, onCancel }: {
  hotFix: StudioSkillHotFix
  saving: boolean
  onChange(draft: string): void
  onSave(): void
  onCancel(): void
}) {
  return (
    <div className="editor-sheet">
      <div className="surface-heading">
        <span>Edit Skill</span>
      </div>
      <label className="form-field">
        <span>SKILL.md</span>
        <textarea onChange={event => onChange(event.target.value)} rows={20} spellCheck={false} value={hotFix.draft} />
      </label>
      <div className="button-row">
        <button className="action-button action-button-primary" disabled={saving || hotFix.draft.trim() === ''} onClick={onSave} type="button">
          {saving ? 'Saving...' : 'Save Skill'}
        </button>
        <button className="action-button" disabled={saving} onClick={onCancel} type="button">Cancel</button>
      </div>
    </div>
  )
}

/** The detail's diagnostics: the last report and the run that refreshes it. */
interface StudioSkillDiagnosticsState {
  report: StudioSkillDiagnosticsAnswer | null
  running: boolean
  onDiagnose(): void
}

function StudioSkillView({ detail, tab, onTab, onEdit, diagnostics }: {
  detail: StudioSkillDetail
  tab: StudioSkillDetailTab
  onTab(tab: StudioSkillDetailTab): void
  onEdit: (() => void) | null
  diagnostics: StudioSkillDiagnosticsState
}) {
  const text = detail.file ?? detail.content
  return (
    <div className="editor-sheet">
      <div className="skill-detail-header">
        <div className="skill-detail-title-row">
          <div className="skill-detail-title-copy">
            <h2 className="skill-detail-name">{detail.name}</h2>
            {detail.path !== undefined && <code className="skill-detail-path">{detail.path}</code>}
          </div>
          {onEdit !== null && (
            <div className="button-row">
              <button className="action-button" onClick={onEdit} type="button">Edit</button>
            </div>
          )}
        </div>
        <div className="skill-detail-chips">
          <span className={`badge ${detail.modelInvocable ? 'accent' : ''}`}>{studioSkillInvocation(detail)}</span>
          {detail.metadataProblem !== undefined && <span className="badge err" title={detail.metadataProblem}>元数据无效</span>}
          {detail.requiredTools.map(tool => <span className="chip" key={tool}>{tool}</span>)}
          {detail.updatedAt !== undefined && <span className="chip">updated {formatStudioRelativeTime(detail.updatedAt)}</span>}
        </div>
      </div>

      <div className="skill-detail-tabs">
        <button className={tab === 'skill' ? 'active' : ''} onClick={() => onTab('skill')} type="button">SKILL.md</button>
        <button className={tab === 'diagnostics' ? 'active' : ''} onClick={() => onTab('diagnostics')} type="button">Diagnostics</button>
      </div>

      {tab === 'skill' && (
        <StudioCodeBody value={text}>
          <pre className="code-block">{text === '' ? 'File is empty.' : text}</pre>
        </StudioCodeBody>
      )}
      {tab === 'diagnostics' && <StudioSkillDiagnosticsPanel onDiagnose={diagnostics.onDiagnose} report={diagnostics.report} running={diagnostics.running} />}
    </div>
  )
}

/** One skill's detail, mounted per skill so its tab, diagnostics, and edit start fresh. */
function StudioSkillPane({ agent, name, canHotFix, setFeedback, onSaved }: {
  agent: StudioAgent
  name: string
  canHotFix: boolean
  setFeedback(feedback: StudioSkillFeedback | null): void
  onSaved(skill: StudioSkillDetail): void
}) {
  const { refreshAgents } = useStudioShell()
  const confirm = useStudioConfirm()
  const detail = useStudioCall(useCallback(() => studioApi.skill(agent.id, name), [agent.id, name]))
  const [tab, setTab] = useState<StudioSkillDetailTab>('skill')
  const [report, setReport] = useState<StudioSkillDiagnosticsAnswer | null>(null)
  const [diagnosing, setDiagnosing] = useState(false)
  const [hotFix, setHotFix] = useState<StudioSkillHotFix | null>(null)
  const [saving, setSaving] = useState(false)

  const diagnose = async (): Promise<void> => {
    setDiagnosing(true)
    setFeedback(null)
    try {
      setReport(await studioApi.diagnoseSkill(agent.id, name))
      setTab('diagnostics')
    } catch (nextError: unknown) {
      setFeedback({ text: studioErrorMessage(nextError), error: true })
    } finally {
      setDiagnosing(false)
    }
  }

  const save = async (fix: StudioSkillHotFix): Promise<void> => {
    if (agent.release !== undefined) {
      const confirmed = await confirm({ title: '热修已发布的 agent', message: studioHotFixWarning(agent.release.version), tone: 'danger' })
      if (!confirmed) return
    }
    setSaving(true)
    setFeedback(null)
    try {
      const answer = await studioApi.updateSkill(agent.id, name, { file: fix.draft }, fix.sha256)
      detail.setAnswer(answer.skill)
      setHotFix(null)
      setReport(null)
      setTab('skill')
      setFeedback({ text: STUDIO_SKILL_SAVED, error: false })
      onSaved(answer.skill)
      void refreshAgents()
    } catch (nextError: unknown) {
      setFeedback({ text: studioErrorCode(nextError) === 'precondition_failed' ? STUDIO_SKILL_CHANGED_SINCE_READ : studioErrorMessage(nextError), error: true })
    } finally {
      setSaving(false)
    }
  }

  if (detail.error !== null) return <div className="empty-surface">{detail.error}</div>
  if (detail.answer === null) return <div className="empty-surface">Loading skill...</div>
  if (hotFix !== null) {
    return <StudioSkillEditor hotFix={hotFix} onCancel={() => setHotFix(null)} onChange={draft => setHotFix({ ...hotFix, draft })} onSave={() => void save(hotFix)} saving={saving} />
  }
  const source = canHotFix ? studioHotFixSource(detail.answer) : null
  return (
    <StudioSkillView
      detail={detail.answer}
      diagnostics={{ report, running: diagnosing, onDiagnose: () => void diagnose() }}
      onEdit={source === null ? null : () => setHotFix(source)}
      onTab={setTab}
      tab={tab}
    />
  )
}

/** The Skills section of an agent's workspace. */
export function StudioAgentSkills({ agent }: { agent: StudioAgent }) {
  const { user } = useStudioAuth()
  const list = useStudioCall(useCallback(() => studioApi.skills(agent.id), [agent.id]))
  const [searchParams, setSearchParams] = useSearchParams()
  const [query, setQuery] = useState('')
  const [feedback, setFeedback] = useState<StudioSkillFeedback | null>(null)
  const [collapsed, toggleCollapsed] = useStudioRailCollapse('agent-skills')

  if (list.error !== null) return <div className="empty-surface">{list.error}</div>
  if (list.answer === null) return <div className="empty-surface">Loading skills...</div>
  const { skills } = list.answer
  const requested = searchParams.get('skill')
  const selected = skills.find(skill => skill.name === requested) ?? skills[0]
  const select = (name: string): void => {
    setFeedback(null)
    setSearchParams({ skill: name }, { replace: true })
  }
  const saved = (skill: StudioSkillDetail): void => {
    list.setAnswer(current => current === null ? null : { ...current, skills: current.skills.map(item => item.name === skill.name ? skill : item) })
  }

  return (
    <section className={`workspace-split ${collapsed ? 'list-collapsed' : ''}`}>
      {collapsed
        ? <StudioCollapsedRail count={skills.length} label="Skills" onExpand={toggleCollapsed} />
        : <StudioSkillRail onCollapse={toggleCollapsed} onSelect={select} query={query} selectedName={selected?.name} setQuery={setQuery} skills={skills} />}
      <div className="workspace-surface split-detail">
        {feedback !== null && <div className={`feedback-banner ${feedback.error ? 'feedback-banner-error' : ''}`}>{feedback.text}</div>}
        {selected === undefined
          ? <div className="empty-surface">Select a skill.</div>
          : <StudioSkillPane agent={agent} canHotFix={user?.role === 'admin'} key={selected.name} name={selected.name} onSaved={saved} setFeedback={setFeedback} />}
      </div>
    </section>
  )
}
