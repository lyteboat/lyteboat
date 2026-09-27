/**
 * The finance agent's admission, run before a request enters the loop. A side
 * call classifies the request: the customer's own money, investor education,
 * small talk, or none of these. Education and small talk are always admitted,
 * with or without a customer; a request about the customer's money needs a
 * customer the context names and the source knows, and is admitted once the
 * agent can see an authorized account, otherwise answered with the
 * unauthorized card; anything else is answered with the service scope. A
 * classification that fails admits the request: the persona's boundary still
 * holds in the loop, and the tools fall back to the unauthorized card
 * themselves.
 * @module @lyteboat/agent-finance/intake/finance-admission
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { LyteboatAgentHost } from '@lyteboat/agent-def'
import { LYTEBOAT_HISTORY_IMPORT_SOURCE, type JsonValue } from '@lyteboat/contracts'
import type { LyteboatAdmission } from '@lyteboat/intake-guard'
import type { FinanceCustomerSource } from '../data/finance-customer.ts'
import { summarizeHoldings } from '../capabilities/finance-holdings.ts'

/** The admission's name: the verdict's `by`, and the author of its replies. */
export const FINANCE_ADMISSION = 'finance-admission'

/** What a request is about, as the classifier reads it. */
export type FinanceIntent = 'asset' | 'education' | 'chat' | 'other'

export const FINANCE_INTAKE_SYSTEM = [
  '你是理财助手的准入分类器。判断用户最新一句话属于哪一类，只输出一行 JSON：{"intent": "asset" | "education" | "chat" | "other", "reason": "不超过 20 字"}。',
  '- asset：想看自己的资产、持仓，问自己的配置合不合理、该怎么调整。',
  '- education：问理财常识或概念（什么是再平衡、基金和股票有什么区别），不涉及自己的具体资产。',
  '- chat：打招呼、道谢、道别，或问助手能做什么。',
  '- other：明显与个人理财无关的请求（写代码、写诗、查天气），或要求预测收益、推荐具体产品、判断个股能不能买、给买卖时点。',
  '追问（为什么、那怎么办、细看一下）按对话里上一个话题归类。拿不准时归 asset 或 education，不要归 other。',
].join('\n')

/**
 * Output budget of one classification: the JSON line needs about 40 tokens;
 * the rest is room for a route that thinks first, whose thinking spends from
 * the same budget.
 */
const FINANCE_INTAKE_MAX_TOKENS = 200
const FINANCE_INTAKE_TIMEOUT_MS = 8000

const REPLY_OUT_OF_SCOPE = '这个问题不在我的服务范围内。我可以帮您看看资产、诊断配置，或者讲讲理财常识。'
const REPLY_UNAUTHORIZED = '您还没有授权任何账户，授权后我就能帮您看资产了。'
const REPLY_NO_CUSTOMER = '暂时没能识别您的身份，请从已登录的入口进来后再试。'

/** The request context key naming the customer. */
export const FINANCE_CUSTOMER_KEY = 'customer'

/** The customer a request context names, when it names one. */
export function customerOfContext(context: { readonly [key: string]: JsonValue }): string | undefined {
  const customer = context[FINANCE_CUSTOMER_KEY]
  return typeof customer === 'string' && customer !== '' ? customer : undefined
}

/** A user message a person wrote: in this session, or imported from the conversation before it. */
const PERSON_SOURCES: ReadonlySet<string> = new Set(['user', LYTEBOAT_HISTORY_IMPORT_SOURCE])

/**
 * The classifier's prompt: the last few lines of the conversation, for
 * follow-ups, then the request.
 * @param agent - the agent whose session holds the conversation.
 * @param text - the request.
 */
export function financeIntakePrompt(agent: Agent, text: string): string {
  const history = agent.session.deriveMessages()
    .filter(message => (message.role === 'user' && PERSON_SOURCES.has(message.source.kind)) || message.role === 'assistant')
    .map(message => `${message.role === 'user' ? '用户' : '助手'}：${message.content.filter(block => block.type === 'text').map(block => block.text).join('').slice(0, 200)}`)
    .filter(line => !line.endsWith('：'))
    .slice(-4)
  return [`<conversation>\n${history.length === 0 ? '（无）' : history.join('\n')}\n</conversation>`, `<latest>${text}</latest>`].join('\n')
}

/** The intent in the classifier's answer; undefined when it is not one. */
export function intentOf(answer: string): FinanceIntent | undefined {
  const json = /\{[\s\S]*\}/u.exec(answer)?.[0]
  if (json === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return undefined
  }
  const intent = typeof parsed === 'object' && parsed !== null ? (parsed as { intent?: unknown }).intent : undefined
  return intent === 'asset' || intent === 'education' || intent === 'chat' || intent === 'other' ? intent : undefined
}

/** What the admission reads. */
export interface FinanceAdmissionDeps {
  customers: FinanceCustomerSource
  auxLlm: LyteboatAgentHost['auxLlm']
  a2ui: LyteboatAgentHost['a2ui']
  /** Absolute path of the agent's a2ui templates root. */
  templates: string
}

/**
 * The finance agent's admission function.
 * @param deps - the customer source, the side-call service, and the card renderer.
 */
export function financeAdmission(deps: FinanceAdmissionDeps): LyteboatAdmission {
  return {
    name: FINANCE_ADMISSION,
    admit: async ({ agent, text, context, signal }) => {
      const outcome = await deps.auxLlm.generate({
        agent, purpose: 'intake', system: FINANCE_INTAKE_SYSTEM, prompt: financeIntakePrompt(agent, text), maxTokens: FINANCE_INTAKE_MAX_TOKENS, timeoutMs: FINANCE_INTAKE_TIMEOUT_MS, signal,
      })
      const intent = outcome.kind === 'answer' ? intentOf(outcome.text) : undefined
      if (intent === undefined) return { decision: 'pass', verdict: 'unclassified' }
      if (intent === 'other') return { decision: 'reply', verdict: 'out_of_scope', text: REPLY_OUT_OF_SCOPE }
      if (intent === 'education' || intent === 'chat') return { decision: 'pass', verdict: intent }
      const customerId = customerOfContext(context)
      const customer = customerId === undefined ? undefined : deps.customers.findCustomer(customerId)
      if (customer === undefined) return { decision: 'reply', verdict: 'no_customer', text: REPLY_NO_CUSTOMER }
      if (summarizeHoldings(customer).authorized) return { decision: 'pass', verdict: 'asset' }
      return { decision: 'reply', verdict: 'unauthorized', text: REPLY_UNAUTHORIZED, cards: [await deps.a2ui.renderCard(deps.templates, 'unauthorized', { access: { authorize_link: customer.links.authorize } }, { agent })] }
    },
  }
}
