/**
 * The scripted model both finance compositions talk to: the admission
 * classifier and the router choose by the task, and the loop calls the routed
 * tool, then answers with a marker for every card the tool prepared.
 */
import { fileURLToPath } from 'node:url'
import type { ChatBlock, RecordedRequest, ScriptedReply } from '@lyteboat/testkit/scripted-model'

/** The examples/agents root this package lives in, as `--agents ./examples/agents` names it. */
export const AGENTS = fileURLToPath(new URL('../../..', import.meta.url))

/** The skill and tool call each task routes to. */
const PLANS: Record<string, { skill: string; tool: string; args?: Record<string, unknown> }> = {
  看看我的资产: { skill: 'asset-overview', tool: 'asset_overview' },
  我的配置合理吗: { skill: 'allocation-diagnosis', tool: 'allocation_diagnosis' },
  什么是再平衡: { skill: 'investor-education', tool: 'lookup_knowledge', args: { topic: '再平衡' } },
}

export const FINANCE_TOOLS = ['asset_overview', 'allocation_diagnosis', 'lookup_knowledge']

export function blockText(block: ChatBlock): string {
  return block.text ?? (Array.isArray(block.content) ? (block.content as ChatBlock[]).map(blockText).join('') : '')
}

/** The text of the latest tool result in a request. */
export function lastToolResult(request: RecordedRequest): string {
  const results = request.body.messages.flatMap(message => message.content.filter(block => block.type === 'tool_result'))
  return results.map(blockText).at(-1) ?? ''
}

/** The finance admission's classifier call: the scripted model sees it as a loop request with its own system text. */
export const isIntake = (request: RecordedRequest): boolean => request.systemText.includes('准入分类器')
export const isLoop = (request: RecordedRequest): boolean => request.purpose === 'loop' && !isIntake(request)

export function financeScript(request: RecordedRequest): ScriptedReply {
  if (isIntake(request)) {
    const latest = /<latest>([\s\S]*?)<\/latest>/u.exec(request.lastUser)?.[1] ?? ''
    const plan = PLANS[latest]
    return { text: JSON.stringify({ intent: plan === undefined ? 'other' : plan.skill === 'investor-education' ? 'education' : 'asset', reason: 'test' }) }
  }
  if (request.purpose === 'router') {
    const latest = /<latest_user_input>([\s\S]*?)<\/latest_user_input>/u.exec(request.lastUser)?.[1] ?? ''
    return { text: JSON.stringify({ skill_id: PLANS[latest]?.skill ?? null, reason: 'test' }) }
  }
  const plan = Object.values(PLANS).find(candidate => request.toolNames.includes(candidate.tool))
  if (plan !== undefined && !request.calledTools.includes(plan.tool)) return { toolCall: { name: plan.tool, arguments: plan.args ?? {}, id: `call-${plan.tool}` } }
  const areas = /areas=([^\]\s]+)/u.exec(lastToolResult(request))?.[1] ?? 'none'
  const markers = areas === 'none' ? [] : areas.split(',').map(area => `[[card:${area}]]`)
  return { text: ['FINANCE-OK', ...markers].join('\n') }
}
