/**
 * The Evals surface's own frame at `/evals`, a sibling of the Studio shell as
 * in the original Studio: the top bar branded 轻舟 Eval (role, user, theme,
 * sign-out), an agent radar of the Studio's agents, read as the Studio shell
 * reads them (searchable, or why they could not be read; a card opens that
 * agent's runs, never its Studio workspace), a "← Studio" link back, and the
 * page beside it. The Studio's sidebar opens this surface in a new tab.
 * `/evals` itself opens the first agent's runs. The original's topbar had no
 * theme switch; this one carries the Studio's, since the surface lives in a
 * tab of its own.
 * @module @lyteboat/studio-web/client/studio-evals-shell
 */

import { useMemo, useState } from 'react'
import { NavLink, Navigate, Outlet, useNavigate, useOutletContext, useParams } from 'react-router-dom'
import type { StudioAgent } from '@lyteboat/contracts/studio'
import { useStudioAuth } from './studio-auth-context.tsx'
import { StudioEvalsEmpty } from './studio-evals-primitives.tsx'
import { BeakerIcon, LogoutIcon, RefreshIcon, SearchIcon } from './studio-icons.tsx'
import { studioAgentName, studioAgentSearchFields, useStudioAgents } from './studio-shell.tsx'
import { studioTextMatches } from './studio-text-filter.ts'
import { StudioThemeToggle } from './studio-theme-toggle.tsx'

type StudioEvalsAgents = ReturnType<typeof useStudioAgents>

/** The first agent's runs; `/evals` lands here. */
export function StudioEvalsFirstAgentRedirect() {
  const { agents, agentsLoading, agentsError } = useOutletContext<StudioEvalsAgents>()
  if (agentsLoading) return <StudioEvalsEmpty hint="Loading…" />
  if (agentsError !== null) return <StudioEvalsEmpty hint={agentsError} title="Could not load agents" />
  const first = agents[0]
  if (first === undefined) return <StudioEvalsEmpty hint="Register an agent before you can run evals against it." title="No agents registered" />
  return <Navigate replace to={`/evals/${first.id}/runs`} />
}

function StudioEvalsTopBar() {
  const navigate = useNavigate()
  const { user, loginRequired, signOut } = useStudioAuth()
  return (
    <header className="evals-topbar">
      <button className="evals-topbar-brand" onClick={() => void navigate('/evals')} type="button">
        <span aria-hidden="true" className="evals-topbar-mark"><BeakerIcon /></span>
        <span className="evals-topbar-copy">
          <strong>轻舟 Eval</strong>
          <span>Agent 评测与调优工作台</span>
        </span>
      </button>
      <div className="evals-topbar-meta">
        {user !== null && <span className="evals-topbar-chip">Role · {user.role}</span>}
        {user !== null && <span className="evals-topbar-chip">User · {user.displayName}</span>}
        <StudioThemeToggle />
        {loginRequired && (
          <button className="evals-topbar-chip evals-topbar-chip-button" onClick={signOut} type="button">
            <LogoutIcon /> Sign out
          </button>
        )}
      </div>
    </header>
  )
}

function StudioEvalsRadarCard({ agent, active }: { agent: StudioAgent; active: boolean }) {
  const navigate = useNavigate()
  return (
    <button aria-current={active} className={`evals-radar-card ${active ? 'active' : ''}`} onClick={() => void navigate(`/evals/${agent.id}/runs`)} type="button">
      <div className="evals-radar-card-top">
        <strong>{studioAgentName(agent)}</strong>
        <span className="evals-radar-card-id">{agent.id.toUpperCase()}</span>
      </div>
      <p>{agent.description ?? '暂无描述。'}</p>
    </button>
  )
}

function StudioEvalsRadar({ radar, currentAgentId }: { radar: StudioEvalsAgents; currentAgentId: string | undefined }) {
  const { agents, agentsLoading, agentsError, refreshAgents } = radar
  const [query, setQuery] = useState('')
  const visible = useMemo(() => agents.filter(agent => studioTextMatches(query, studioAgentSearchFields(agent))), [agents, query])
  return (
    <aside aria-label="Agents" className="evals-radar">
      <div className="evals-radar-head">
        <span>Agents · {agents.length}</span>
        <button aria-label="Refresh agents" className="evals-radar-refresh" disabled={agentsLoading} onClick={() => void refreshAgents()} title="Refresh" type="button"><RefreshIcon /></button>
      </div>
      <label className="evals-radar-search">
        <SearchIcon />
        <input aria-label="Search agents" onChange={event => setQuery(event.target.value)} placeholder="Search agents" value={query} />
      </label>
      <div className="evals-radar-list">
        {agentsLoading && <StudioEvalsEmpty hint="Loading agents…" />}
        {agentsError !== null && <StudioEvalsEmpty hint={agentsError} />}
        {!agentsLoading && agentsError === null && agents.length === 0 && <StudioEvalsEmpty hint="No agents registered." />}
        {!agentsLoading && agentsError === null && agents.length > 0 && visible.length === 0 && <StudioEvalsEmpty hint="No agents match." />}
        {visible.map(agent => <StudioEvalsRadarCard active={agent.id === currentAgentId} agent={agent} key={agent.id} />)}
      </div>
      <nav aria-label="Other surfaces" className="evals-radar-footer">
        <NavLink className="evals-radar-footer-item" to="/">← Studio</NavLink>
      </nav>
    </aside>
  )
}

/** The frame of every page under `/evals`. */
export function StudioEvalsShell() {
  const { agentId } = useParams<{ agentId?: string }>()
  const radar = useStudioAgents()
  return (
    <div className="evals-shell">
      <StudioEvalsTopBar />
      <div className="evals-shell-body">
        <StudioEvalsRadar currentAgentId={agentId} radar={radar} />
        <main className="evals-shell-main">
          <Outlet context={radar} />
        </main>
      </div>
    </div>
  )
}
