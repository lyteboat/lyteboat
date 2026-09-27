/**
 * The agent radar's endpoints: `agents` lists what the catalog serves once
 * it has settled; `agents/reload` (admins) re-reads the agent roots, audited.
 * @module @lyteboat/studio-api/studio-agent-routes
 */

import type { AgentCatalogService } from '@lyteboat/agent-catalog'
import type { StudioAgentsAnswer } from '@lyteboat/contracts/studio'
import { studioAgentsAnswer } from './studio-agents.ts'
import type { StudioAudit } from './studio-audit.ts'
import { studioCallerOf } from './studio-auth-routes.ts'
import { studioCatalogSettled, type StudioApiRoute } from './studio-api-router.ts'

async function settledAgents(catalog: AgentCatalogService, settling: Promise<void>): Promise<StudioAgentsAnswer> {
  await studioCatalogSettled(settling)
  return studioAgentsAnswer(catalog.list(), catalog.failures())
}

/**
 * The routes.
 * @param catalog - the agentCatalog service.
 * @param audit - the audit log.
 */
export function studioAgentRoutes(catalog: AgentCatalogService, audit: StudioAudit): StudioApiRoute[] {
  return [
    { method: 'GET', path: 'agents', access: 'viewer', handle: () => settledAgents(catalog, catalog.whenReady()) },
    {
      method: 'POST', path: 'agents/reload', access: 'admin',
      handle: async (call) => {
        const answer = await settledAgents(catalog, catalog.reload())
        await audit.record({ actor: studioCallerOf(call).userId, action: 'agents.reload', agents: answer.agents.length, failures: answer.failures.length })
        return answer
      },
    },
  ]
}
