/**
 * The Dashboard's endpoints, for any signed-in role: `dashboard/health`
 * (the performance view from serve's run metrics, of one agent or all the
 * catalog serves, bucketed, with an optional comparison window; answers are
 * reused for 30 seconds), `dashboard/summary` (the static view from the
 * agents, their skills and tools, and their end users' sessions; reused for
 * 2 seconds; its activity includes the agents' eval runs), and
 * `dashboard/running` (the turns serve processes are running, from their
 * heartbeats).
 * @module @lyteboat/studio-api/studio-dashboard-routes
 */

import { statSync } from 'node:fs'
import type { AgentCatalogService } from '@lyteboat/agent-catalog'
import type { AgentInspectorService } from '@lyteboat/agent-inspector'
import type { StudioDashboardHealth, StudioDashboardRunning, StudioDashboardSummary } from '@lyteboat/contracts/studio'
import type { EvalRecordsService } from '@lyteboat/eval-runner/records'
import type { RunMetricsReaderService } from '@lyteboat/run-metrics/reader'
import type { SessionIndexService } from '@lyteboat/session-index'
import { studioWholeNumberOf } from './studio-auth-routes.ts'
import { StudioApiError, studioCatalogSettled, type StudioApiCall, type StudioApiRoute } from './studio-api-router.ts'
import { studioBucketMinutes, studioHealthWindow } from './studio-dashboard-health.ts'
import { studioDashboardSummary, type StudioSummaryAgent } from './studio-dashboard-summary.ts'

/** What the Dashboard reads. */
interface StudioDashboardServices {
  catalog: AgentCatalogService
  inspector: AgentInspectorService
  sessions: SessionIndexService
  metrics: RunMetricsReaderService
  evals: EvalRecordsService
}

const HEALTH_REUSE_MS = 30_000
const SUMMARY_REUSE_MS = 2_000
const MAX_BUCKET_MINUTES = 1440

/** An answer reused while it is younger than `ms`, per key. */
class StudioReusedAnswers<T> {
  private readonly answers = new Map<string, { at: number; answer: Promise<T> }>()

  constructor(private readonly ms: number) {}

  get(key: string, make: () => Promise<T>): Promise<T> {
    const now = Date.now()
    for (const [old, { at }] of this.answers) if (now - at >= this.ms) this.answers.delete(old)
    const reused = this.answers.get(key)
    if (reused !== undefined) return reused.answer
    const answer = make()
    this.answers.set(key, { at: now, answer })
    // A failed answer is not reused: the next call tries again.
    answer.catch(() => { this.answers.delete(key) })
    return answer
  }
}

function timeOf(query: URLSearchParams, name: string): number {
  if (!query.has(name)) throw new StudioApiError('invalid_request', `${name} is required (epoch ms)`)
  return studioWholeNumberOf(query, name, 0, Number.MAX_SAFE_INTEGER)
}

function bucketOf(from: number, to: number, requested: number | undefined, window: string): number {
  if (to <= from) throw new StudioApiError('invalid_request', `the ${window} window must end after it starts`)
  const minutes = studioBucketMinutes(from, to, requested)
  if (minutes === undefined) throw new StudioApiError('invalid_request', `the ${window} window makes more than 500 buckets; pick a larger bucket`)
  return minutes
}

async function dashboardHealth(services: StudioDashboardServices, call: StudioApiCall): Promise<StudioDashboardHealth> {
  const { query } = call
  const from = timeOf(query, 'from')
  const to = timeOf(query, 'to')
  const requested = query.has('bucket') ? Math.max(1, studioWholeNumberOf(query, 'bucket', 0, MAX_BUCKET_MINUTES)) : undefined
  if (query.has('compareFrom') !== query.has('compareTo')) throw new StudioApiError('invalid_request', 'compareFrom and compareTo go together')
  const agent = query.get('agent') ?? undefined
  await studioCatalogSettled(services.catalog.whenReady())
  if (agent !== undefined && services.catalog.get(agent) === undefined) throw new StudioApiError('not_found', `no agent ${agent}`)
  const agentIds = agent === undefined ? services.catalog.list().map(entry => entry.id).sort() : [agent]
  const bucket = bucketOf(from, to, requested, 'current')
  const window = async (start: number, end: number): Promise<ReturnType<typeof studioHealthWindow>> => {
    const rows = (await services.metrics.records(start, end, agent)).filter(row => agentIds.includes(row.agentId))
    return studioHealthWindow(rows, start, end, bucket)
  }
  const current = await window(from, to)
  if (!query.has('compareFrom')) return { agentIds, current }
  const compareFrom = timeOf(query, 'compareFrom')
  const compareTo = timeOf(query, 'compareTo')
  bucketOf(compareFrom, compareTo, bucket, 'comparison')
  return { agentIds, current, comparison: await window(compareFrom, compareTo) }
}

async function dashboardRunning(services: StudioDashboardServices): Promise<StudioDashboardRunning> {
  const counts = new Map<string, number>()
  for (const turn of await services.metrics.running()) counts.set(turn.agentId, (counts.get(turn.agentId) ?? 0) + 1)
  const agents = services.catalog.list()
    .filter(entry => (counts.get(entry.id) ?? 0) > 0)
    .map(entry => ({ agentId: entry.id, agentLabel: entry.name ?? entry.id, running: counts.get(entry.id) ?? 0 }))
  return { total: agents.reduce((sum, agent) => sum + agent.running, 0), agents }
}

function modifiedAt(file: string | undefined): number | undefined {
  if (file === undefined) return undefined
  try {
    return Math.round(statSync(file).mtimeMs)
  } catch {
    // A skill file removed since the listing has no time; the skill still counts.
    return undefined
  }
}

async function summaryAgents(services: StudioDashboardServices): Promise<StudioSummaryAgent[]> {
  await studioCatalogSettled(services.catalog.whenReady())
  const agents: StudioSummaryAgent[] = []
  const evalRuns = services.evals.runs().flatMap(({ runId, record }) => record === undefined ? [] : [{
    agentId: record.agent.id, runId, startedAt: Date.parse(record.startedAt), passed: record.cases.filter(evalCase => evalCase.pass).length, total: record.cases.length,
  }])
  for (const entry of services.catalog.list()) {
    const skills = (await services.inspector.skills(entry.id))?.skills ?? []
    const tools = await services.inspector.tools(entry.id) ?? []
    const sessions = (await services.sessions.list(entry.id, { limit: Number.MAX_SAFE_INTEGER, offset: 0 }))?.sessions ?? []
    agents.push({
      id: entry.id,
      label: entry.name ?? entry.id,
      skills: skills.map((skill) => {
        const updatedAt = modifiedAt(skill.file)
        return { name: skill.name, modelInvocable: skill.modelInvocable, requiredTools: skill.requiredTools, ...updatedAt === undefined ? {} : { updatedAt } }
      }),
      toolCount: tools.filter(tool => tool.reach !== 'hidden').length,
      sessions,
      evalRuns: evalRuns.filter(run => run.agentId === entry.id),
    })
  }
  return agents
}

/**
 * The routes.
 * @param services - the catalog, the inspector, the session index, the run-metrics reader, and the eval records.
 */
export function studioDashboardRoutes(services: StudioDashboardServices): StudioApiRoute[] {
  const health = new StudioReusedAnswers<StudioDashboardHealth>(HEALTH_REUSE_MS)
  const summary = new StudioReusedAnswers<StudioDashboardSummary>(SUMMARY_REUSE_MS)
  return [
    { method: 'GET', path: 'dashboard/health', access: 'viewer', handle: call => health.get(call.query.toString(), () => dashboardHealth(services, call)) },
    { method: 'GET', path: 'dashboard/summary', access: 'viewer', handle: () => summary.get('summary', async () => studioDashboardSummary(await summaryAgents(services), Date.now())) },
    { method: 'GET', path: 'dashboard/running', access: 'viewer', handle: () => dashboardRunning(services) },
  ]
}
