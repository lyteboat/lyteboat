/**
 * The three finance tools, each `auto`: a tool reaches the model only while
 * the routed skill names it in `requiredTools`. Registration order is the
 * order here.
 * @module @lyteboat/agent-finance/tools/finance-tools
 */

import type { LyteboatAgentTool } from '@lyteboat/agent-def'
import { defineAllocationDiagnosisTool } from './allocation-diagnosis-tool.ts'
import { defineAssetOverviewTool } from './asset-overview-tool.ts'
import type { FinanceToolDeps } from './finance-tool-support.ts'
import { defineLookupKnowledgeTool } from './lookup-knowledge-tool.ts'

/**
 * Every finance tool, for the agent's definition.
 * @param deps - the finance tool dependencies.
 * @returns the tools with their visibility.
 */
export function financeTools(deps: FinanceToolDeps): LyteboatAgentTool[] {
  return [defineAssetOverviewTool(deps), defineAllocationDiagnosisTool(deps), defineLookupKnowledgeTool(deps)]
    .map((definition): LyteboatAgentTool => ({ definition, visibility: 'auto' }))
}
