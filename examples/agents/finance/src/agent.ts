/**
 * The finance agent: its one declaration. The persona is the whole system
 * prompt; the router picks one of the three skills under `assets/skills` for
 * every request; every inherited tool but `skill` stays away from the model,
 * and each finance tool reaches it only while the routed skill requires it;
 * loop requests run at temperature 0 (tool choice favors a stable decision
 * over varied wording). The admission answers out-of-scope requests and
 * customers with nothing authorized before the loop runs. The customer is the
 * one the session's request context names (`customer`).
 * @module @lyteboat/agent-finance/agent
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { lyteboatAgentDef, type LyteboatAgentHost } from '@lyteboat/agent-def'
import { loadKnowledge } from './capabilities/investor-knowledge.ts'
import { FixtureCustomerSource, type FinanceCustomerSource } from './data/finance-customer.ts'
import { FINANCE_PERSONA } from './finance-persona.ts'
import { customerOfContext, financeAdmission } from './intake/finance-admission.ts'
import { financeTools } from './tools/finance-tools.ts'

const financeCustomerSources = new WeakMap<LyteboatAgentHost, FinanceCustomerSource>()

/**
 * The customers this deployment serves: fixture files, which a real deployment
 * replaces with its own source. One source per mounted agent, which its
 * admission and its tools share as their one data layer.
 */
function financeCustomersOf(host: LyteboatAgentHost): FinanceCustomerSource {
  const known = financeCustomerSources.get(host)
  if (known !== undefined) return known
  const customers = new FixtureCustomerSource(host.agentPath('assets/sample-data/customers'))
  financeCustomerSources.set(host, customers)
  return customers
}

/** The agent's card templates. */
const financeTemplatesDirOf = (host: LyteboatAgentHost): string => host.agentPath('assets/a2ui')

/** The customer a session serves, from its request context; a finance tool cannot run without one. */
function financeCustomerIdOf(host: LyteboatAgentHost): (agent: Agent) => string {
  return (agent) => {
    const customerId = customerOfContext(host.requestContext.contextOf(agent))
    if (customerId === undefined) throw new Error('finance: the request context names no customer (context.customer)')
    return customerId
  }
}

export default lyteboatAgentDef({
  agentId: 'finance',
  agentName: '金融智能体',
  persona: { prefix: FINANCE_PERSONA, complete: true },
  skillRouting: { mode: 'dynamic', historyWindow: 6, timeoutMs: 10_000 },
  toolPolicy: { inherited: 'hidden', tools: { skill: { visibility: 'always' } } },
  modelRequest: { temperature: 0 },
  admission: host => financeAdmission({
    customers: financeCustomersOf(host),
    auxLlm: host.auxLlm,
    a2ui: host.a2ui,
    templates: financeTemplatesDirOf(host),
  }),
  tools: host => financeTools({
    customers: financeCustomersOf(host),
    customerId: financeCustomerIdOf(host),
    templates: financeTemplatesDirOf(host),
    knowledge: loadKnowledge(host.agentPath('assets/sample-data/knowledge.json')),
    a2ui: host.a2ui,
  }),
})
