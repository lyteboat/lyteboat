/**
 * The agent workspace's endpoints: an agent's skills (the list with its
 * routing, one skill with its body and file, its diagnostics) and tools, all
 * read through agentInspector; and the admin hot-fix of a skill's SKILL.md
 * (`PUT`, `If-Match: <sha256>`), which is audited, reloads the agents so the
 * radar shows the new digest, and restores the previous file when the skill
 * loader no longer accepts the skill.
 * @module @lyteboat/studio-api/studio-workspace-routes
 */

import { readFileSync, realpathSync, statSync } from 'node:fs'
import { relative } from 'node:path'
import type { AgentCatalogEntry, AgentCatalogService } from '@lyteboat/agent-catalog'
import type { AgentInspectorService, AgentInspectorSkillDetail } from '@lyteboat/agent-inspector'
import type { LyteboatInspectedSkill } from '@lyteboat/contracts/cli'
import { studioSkillUpdateRequestSchema, type StudioSkillDetail, type StudioSkillDiagnosticsAnswer, type StudioSkillSummary, type StudioSkillUpdateAnswer } from '@lyteboat/contracts/studio'
import { studioAgentsAnswer } from './studio-agents.ts'
import type { StudioAudit } from './studio-audit.ts'
import { studioCallerOf, studioRequestOf } from './studio-auth-routes.ts'
import { StudioApiError, studioCatalogSettled, type StudioApiCall, type StudioApiRoute } from './studio-api-router.ts'
import { editableStudioSkillFile, replaceStudioFile, studioFileHash, studioSkillFileProblem } from './studio-skill-hotfix.ts'

/** What the workspace endpoints read and change. */
interface StudioWorkspaceServices {
  catalog: AgentCatalogService
  inspector: AgentInspectorService
  audit: StudioAudit
}

function found<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new StudioApiError('not_found', `no ${what}`)
  return value
}

/** An agent the catalog serves once it has settled: a reload (the roots' watcher's too) empties it until then. */
export async function settledAgentOf(catalog: AgentCatalogService, agentId: string): Promise<AgentCatalogEntry> {
  await studioCatalogSettled(catalog.whenReady())
  return found(catalog.get(agentId), `agent ${agentId}`)
}

function studioSkillSummaryOf(skill: LyteboatInspectedSkill, agentDir: string): StudioSkillSummary {
  const file = editableStudioSkillFile(skill.file, agentDir)
  return {
    name: skill.name,
    description: skill.description,
    ...skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse },
    modelInvocable: skill.modelInvocable,
    userInvocable: skill.userInvocable,
    requiredTools: skill.requiredTools,
    ...file === undefined ? {} : { path: relative(realpathSync(agentDir), file), updatedAt: Math.round(statSync(file).mtimeMs) },
    ...skill.metadataProblem === undefined ? {} : { metadataProblem: skill.metadataProblem },
  }
}

function studioSkillDetailOf(skill: AgentInspectorSkillDetail, agentDir: string): StudioSkillDetail {
  const summary = studioSkillSummaryOf(skill, agentDir)
  const file = editableStudioSkillFile(skill.file, agentDir)
  if (file === undefined) return { ...summary, content: skill.content }
  const text = readFileSync(file, 'utf8')
  return { ...summary, content: skill.content, file: text, sha256: studioFileHash(text) }
}

async function settledReload(catalog: AgentCatalogService): Promise<void> {
  try {
    await catalog.reload()
  } catch {
    // Not strict: an agent that fails is listed in failures(); the one hot-fixed is checked by the caller.
  }
}

/** Replace a skill's SKILL.md as `actor`, then reload and answer the skill and its agent. */
async function hotFixStudioSkill(services: StudioWorkspaceServices, call: StudioApiCall, agentId: string, name: string): Promise<StudioSkillUpdateAnswer> {
  const actor = studioCallerOf(call).userId
  const { file: text } = await studioRequestOf(call, studioSkillUpdateRequestSchema)
  const tools = found(await services.inspector.tools(agentId), `agent ${agentId}`)
  const skill = found(await services.inspector.skill(agentId, name), `skill ${name} in agent ${agentId}`)
  const agentDir = (await settledAgentOf(services.catalog, agentId)).dir
  const file = editableStudioSkillFile(skill.file, agentDir)
  if (file === undefined) throw new StudioApiError('conflict', `skill ${name} has no SKILL.md inside the agent directory for Studio to edit`)
  // From here to the write nothing awaits, so a concurrent save cannot slip between the check and the rename.
  const before = readFileSync(file, 'utf8')
  const ifMatch = call.headers['if-match']
  if (ifMatch !== studioFileHash(before)) throw new StudioApiError('precondition_failed', 'the file changed since it was read (If-Match does not match); read it again before saving')
  const problem = studioSkillFileProblem(text, name, tools)
  if (problem !== undefined) throw new StudioApiError('invalid_request', problem)
  replaceStudioFile(file, text)
  await services.audit.record({ actor, action: 'skill.update', agentId, skill: name, path: relative(realpathSync(agentDir), file), before: studioFileHash(before), after: studioFileHash(text) })
  await settledReload(services.catalog)
  const updated = await services.inspector.skill(agentId, name)
  if (updated === undefined) {
    replaceStudioFile(file, before)
    await settledReload(services.catalog)
    throw new StudioApiError('invalid_request', 'the skill loader did not accept the new file; the previous file is restored')
  }
  const agent = studioAgentsAnswer([await settledAgentOf(services.catalog, agentId)], []).agents[0]
  return { skill: studioSkillDetailOf(updated, agentDir), agent: found(agent, `agent ${agentId}`) }
}

/**
 * The routes.
 * @param services - the catalog, the inspector, and the audit log.
 */
export function studioWorkspaceRoutes(services: StudioWorkspaceServices): StudioApiRoute[] {
  const { catalog, inspector } = services
  const idOf = (call: StudioApiCall): string => call.params['id'] ?? ''
  const nameOf = (call: StudioApiCall): string => call.params['name'] ?? ''
  return [
    {
      method: 'GET', path: 'agents/:id/skills', access: 'viewer',
      handle: async (call) => {
        const answer = found(await inspector.skills(idOf(call)), `agent ${idOf(call)}`)
        const agentDir = (await settledAgentOf(catalog, idOf(call))).dir
        return { skills: answer.skills.map(skill => studioSkillSummaryOf(skill, agentDir)), routing: answer.routing }
      },
    },
    {
      method: 'GET', path: 'agents/:id/skills/:name', access: 'viewer',
      handle: async (call) => {
        const skill = found(await inspector.skill(idOf(call), nameOf(call)), `skill ${nameOf(call)} in agent ${idOf(call)}`)
        return studioSkillDetailOf(skill, (await settledAgentOf(catalog, idOf(call))).dir)
      },
    },
    { method: 'PUT', path: 'agents/:id/skills/:name', access: 'admin', handle: call => hotFixStudioSkill(services, call, idOf(call), nameOf(call)) },
    {
      method: 'POST', path: 'agents/:id/skills/:name/diagnostics', access: 'viewer',
      handle: async (call): Promise<StudioSkillDiagnosticsAnswer> => {
        const skill = found(await inspector.skill(idOf(call), nameOf(call)), `skill ${nameOf(call)} in agent ${idOf(call)}`)
        const { routing } = found(await inspector.skills(idOf(call)), `agent ${idOf(call)}`)
        const findings = found((await inspector.findings(idOf(call)))?.find(entry => entry.skill === skill.name), `skill ${nameOf(call)} in agent ${idOf(call)}`)
        return { skill: skill.name, generatedAt: Date.now(), requiredTools: skill.requiredTools, routing: routing.mode, findings: findings.findings }
      },
    },
    { method: 'GET', path: 'agents/:id/tools', access: 'viewer', handle: async call => ({ tools: found(await inspector.tools(idOf(call)), `agent ${idOf(call)}`) }) },
  ]
}
