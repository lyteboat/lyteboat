/**
 * An agent's Tools, laid out as the original Studio's: the searchable,
 * collapsible list of the tools the agent can reach, each with whether it
 * reaches the model (always, once activated, or never), beside the selected
 * tool's detail: how the agent's tool policy declares it, which skills require
 * it, its description, and its parameters' JSON Schema. The selection is the
 * URL's `?tool=<name>` (else the first tool), so a link opens a tool.
 * @module @lyteboat/studio-web/client/studio-agent-tools
 */

import { useCallback, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { StudioTool, StudioToolReach } from '@lyteboat/contracts/studio'
import { studioApi } from './studio-api-client.ts'
import { useStudioCall } from './studio-call-state.ts'
import { StudioCodeBody } from './studio-code-body.tsx'
import { StudioCollapsedRail, StudioRailToggle, useStudioRailCollapse } from './studio-collapsible-rail.tsx'
import { StudioSearchBox } from './studio-search-box.tsx'
import { studioTextMatches } from './studio-text-filter.ts'

const STUDIO_TOOL_REACH_LABEL: Record<StudioToolReach, string> = { always: 'always', activated: '激活后可见', hidden: 'hidden' }

/** How the pages name a tool's reach. */
export function studioToolReachLabel(reach: StudioToolReach): string {
  return STUDIO_TOOL_REACH_LABEL[reach]
}

/** How many parameters a tool's JSON Schema declares (the keys of its `properties`). */
function studioToolParameterCount(tool: StudioTool): number {
  const properties = tool.parameters['properties']
  return typeof properties === 'object' && properties !== null ? Object.keys(properties).length : 0
}

function StudioToolRail({ tools, query, setQuery, selectedName, onSelect, onCollapse }: {
  tools: StudioTool[]
  query: string
  setQuery(query: string): void
  selectedName: string | undefined
  onSelect(name: string): void
  onCollapse(): void
}) {
  const shown = useMemo(() => tools.filter(tool => studioTextMatches(query, [tool.name, tool.description, ...tool.requiredBy])), [query, tools])
  return (
    <div className="workspace-surface split-list">
      <div className="surface-heading">
        <span>Tools</span>
        <span className="surface-heading-trail">
          <span>{tools.length}</span>
          <StudioRailToggle label="Collapse tools" onToggle={onCollapse} />
        </span>
      </div>
      <StudioSearchBox label="Search tools" onChange={setQuery} placeholder="Search tools" value={query} />
      <div className="document-list">
        {shown.map(tool => (
          <button className={`document-card document-button tool-list-card ${selectedName === tool.name ? 'active' : ''}`} key={tool.name} onClick={() => onSelect(tool.name)} type="button">
            <div className="skill-list-card-top">
              <strong>{tool.name}</strong>
              <span className="skill-policy-chip">{studioToolReachLabel(tool.reach)}</span>
            </div>
            <p>{tool.description}</p>
          </button>
        ))}
        {tools.length === 0 && <div className="empty-surface">No tools found.</div>}
        {tools.length > 0 && shown.length === 0 && <div className="empty-surface">No matching tools.</div>}
      </div>
    </div>
  )
}

function StudioToolDetail({ tool }: { tool: StudioTool }) {
  const schema = JSON.stringify(tool.parameters, null, 2)
  return (
    <div className="editor-sheet">
      <div className="skill-detail-header">
        <div className="skill-detail-title-row">
          <div className="skill-detail-title-copy">
            <h2 className="skill-detail-name">{tool.name}</h2>
          </div>
        </div>
        <div className="skill-detail-chips">
          <span className="chip">declared: {tool.declared}</span>
          <span className="chip">{studioToolReachLabel(tool.reach)}</span>
          <span className="chip">{studioToolParameterCount(tool)} params</span>
        </div>
      </div>
      <p className="detail-description">{tool.requiredBy.length > 0 ? `被技能要求：${tool.requiredBy.join(', ')}` : '没有技能要求它。'}</p>
      {tool.description !== '' && <p className="detail-description">{tool.description}</p>}
      <StudioCodeBody value={schema}>
        <pre className="code-light">{schema}</pre>
      </StudioCodeBody>
    </div>
  )
}

/** The Tools section of an agent's workspace; the selected tool is the one `?tool=` names, else the first. */
export function StudioAgentTools({ agentId }: { agentId: string }) {
  const { answer, error } = useStudioCall(useCallback(() => studioApi.tools(agentId), [agentId]))
  const [searchParams, setSearchParams] = useSearchParams()
  const [query, setQuery] = useState('')
  const [collapsed, toggleCollapsed] = useStudioRailCollapse('agent-tools')

  if (error !== null) return <div className="empty-surface">{error}</div>
  if (answer === null) return <div className="empty-surface">Loading tools...</div>
  const { tools } = answer
  const requested = searchParams.get('tool')
  const selected = tools.find(tool => tool.name === requested) ?? tools[0]
  const select = (name: string): void => { setSearchParams({ tool: name }, { replace: true }) }

  return (
    <section className={`workspace-split ${collapsed ? 'list-collapsed' : ''}`}>
      {collapsed
        ? <StudioCollapsedRail count={tools.length} label="Tools" onExpand={toggleCollapsed} />
        : <StudioToolRail onCollapse={toggleCollapsed} onSelect={select} query={query} selectedName={selected?.name} setQuery={setQuery} tools={tools} />}
      <div className="workspace-surface split-detail">
        {selected === undefined ? <div className="empty-surface">Select a tool.</div> : <StudioToolDetail tool={selected} />}
      </div>
    </section>
  )
}
