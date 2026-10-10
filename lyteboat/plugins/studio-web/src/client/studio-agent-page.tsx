/**
 * An agent's workspace at `/agents/:agentId/:section`, laid out as the
 * original Studio's: the context bar (the agent's name, id, version, and
 * description; Test agent opens the test window for editors and admins, the
 * other actions are still to come) over the section tabs, then the
 * section: Overview, Skills, Tools, or Sessions. An unknown section opens the
 * Overview. Each section mounts per agent, so switching agents starts it fresh.
 * @module @lyteboat/studio-web/client/studio-agent-page
 */

import { NavLink, Navigate, useNavigate, useParams } from 'react-router-dom'
import type { StudioAgent } from '@lyteboat/contracts/studio'
import { StudioAgentOverview } from './studio-agent-overview.tsx'
import { StudioAgentSessions } from './studio-agent-sessions.tsx'
import { StudioAgentSkills } from './studio-agent-skills.tsx'
import { StudioAgentTools } from './studio-agent-tools.tsx'
import { canTestStudioAgents, useStudioAuth } from './studio-auth-context.tsx'
import { studioAgentName, useStudioShell } from './studio-shell.tsx'

const STUDIO_AGENT_SECTIONS = ['overview', 'skills', 'tools', 'sessions'] as const

type StudioAgentSection = typeof STUDIO_AGENT_SECTIONS[number]

function StudioAgentContextBar({ agent, activeSection }: { agent: StudioAgent; activeSection: StudioAgentSection }) {
  const navigate = useNavigate()
  const { user } = useStudioAuth()
  const { chatPanelOpen, setChatPanelOpen } = useStudioShell()
  const canTest = canTestStudioAgents(user?.role)
  // As in the original Studio, a tab reached by keyboard focus opens its section at once.
  const focusSection = (section: StudioAgentSection): void => {
    if (section !== activeSection) void navigate(`/agents/${agent.id}/${section}`)
  }
  return (
    <section className="workspace-context-bar">
      <div className="workspace-context-head">
        <div className="workspace-context-copy">
          <div className="workspace-context-title-row">
            <h1>{studioAgentName(agent)}</h1>
            <span className="workspace-context-meta-inline">
              <span>{agent.id.toUpperCase()}</span>
              <span aria-hidden="true">·</span>
              <span>{agent.version === undefined ? '未标版本' : `v${agent.version}`}</span>
            </span>
          </div>
          {agent.description !== undefined && agent.description !== '' && <p>{agent.description}</p>}
        </div>
        <div className="workspace-context-actions">
          <button className="btn btn-sm" disabled title="即将推出" type="button">Configure</button>
          <button className="btn btn-sm" disabled title="即将推出" type="button">Export</button>
          <button
            aria-pressed={chatPanelOpen}
            className="btn btn-accent btn-sm"
            disabled={!canTest}
            onClick={() => setChatPanelOpen(!chatPanelOpen)}
            title={canTest ? '在右侧测试窗里和这个 agent 对话' : '需要 editor 或 admin 角色'}
            type="button"
          >
            Test agent
          </button>
        </div>
      </div>

      <nav aria-label="Agent sections" className="workspace-tab-row">
        {STUDIO_AGENT_SECTIONS.map(section => (
          <NavLink
            aria-label={`${section} section`}
            className={({ isActive }) => `workspace-tab ${isActive ? 'active' : ''}`}
            key={section}
            onFocus={() => focusSection(section)}
            to={`/agents/${agent.id}/${section}`}
          >
            {section}
          </NavLink>
        ))}
      </nav>
    </section>
  )
}

/** The page at `/agents/:agentId/:section`. */
export function StudioAgentPage() {
  const { agentId, section } = useParams<{ agentId: string; section: string }>()
  const { selectedAgent, agentsLoading } = useStudioShell()
  const activeSection = STUDIO_AGENT_SECTIONS.find(item => item === section)

  if (agentId === undefined) return <Navigate replace to="/" />
  if (activeSection === undefined) return <Navigate replace to={`/agents/${agentId}/overview`} />
  // A refresh of the radar (after a hot-fix) keeps the agent on screen; only the first load waits.
  if (selectedAgent === null) {
    return (
      <div className="workspace-page">
        <div className="empty-surface">{agentsLoading ? '正在加载 Agent...' : '没有这个 Agent，或它没有挂载成功（见左侧列表）。'}</div>
      </div>
    )
  }

  return (
    <div className="workspace-page workspace-page-split">
      <div aria-atomic="true" aria-live="polite" className="sr-only">{`${studioAgentName(selectedAgent)}, ${activeSection} section`}</div>
      <StudioAgentContextBar activeSection={activeSection} agent={selectedAgent} />
      {activeSection === 'overview' && <StudioAgentOverview agent={selectedAgent} key={selectedAgent.id} />}
      {activeSection === 'skills' && <StudioAgentSkills agent={selectedAgent} key={selectedAgent.id} />}
      {activeSection === 'tools' && <StudioAgentTools agentId={selectedAgent.id} key={selectedAgent.id} />}
      {activeSection === 'sessions' && <StudioAgentSessions agentId={selectedAgent.id} key={selectedAgent.id} />}
    </div>
  )
}
