/**
 * The Dashboard's static view from the agents, their skills and tools, and
 * their end users' sessions, ported from the original Studio's summary
 * (`plugins/studio/api/dashboard.py`): six-month cumulative trends, the top
 * six of each distribution with its share, the sessions' coverage and
 * message bands, and the twelve newest activities (skill changes, sessions,
 * and eval runs). lyteboat has no memory,
 * no skill groups or tags, and no tool file times: the memory figures are
 * gone, the skills section shows skills per agent and the tools skills
 * require, and tools have a total only. A test-window session (an operator
 * owns it) is an editor trying the agent, not use, and counts nowhere.
 * @module @lyteboat/studio-api/studio-dashboard-summary
 */

import type { StudioActivityItem, StudioDashboardSummary, StudioDistributionItem, StudioInsightStat, StudioSessionSummary, StudioTrendPoint } from '@lyteboat/contracts/studio'
import { studioRoundHalfEven } from './studio-dashboard-health.ts'

const TREND_MONTHS = 6
const DISTRIBUTION_LIMIT = 6
const ACTIVITY_LIMIT = 12

/** One agent as the summary counts it. */
export interface StudioSummaryAgent {
  id: string
  label: string
  skills: { name: string; modelInvocable: boolean; requiredTools: string[]; updatedAt?: number }[]
  /** Its tools that reach the model. */
  toolCount: number
  sessions: StudioSessionSummary[]
  /** Its written eval runs, for the activity feed. */
  evalRuns?: { runId: string; startedAt: number; passed: number; total: number }[]
}

function ratio(part: number, total: number): string {
  return total <= 0 ? '0%' : `${String(studioRoundHalfEven(part / total * 100))}%`
}

/** Python's `f"{value:,}"`. */
function grouped(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/gu, ',')
}

function byCountThenLabel(a: StudioDistributionItem, b: StudioDistributionItem): number {
  return b.value - a.value || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0)
}

function distribution(counts: ReadonlyMap<string, number>, total: number): StudioDistributionItem[] {
  return [...counts].filter(([, value]) => value > 0).map(([label, value]) => ({ label, value, hint: ratio(value, total) })).sort(byCountThenLabel).slice(0, DISTRIBUTION_LIMIT)
}

/** The last `TREND_MONTHS` UTC months up to `now`, each with its last millisecond. */
function monthEnds(now: number): { label: string; shortLabel: string; end: number }[] {
  const today = new Date(now)
  return Array.from({ length: TREND_MONTHS }, (_, index) => {
    const month = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - (TREND_MONTHS - 1 - index), 1))
    const short = String(month.getUTCMonth() + 1).padStart(2, '0')
    return { label: `${String(month.getUTCFullYear())}-${short}`, shortLabel: short, end: Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 1) - 1 }
  })
}

function cumulativeTrend(times: readonly number[], now: number): StudioTrendPoint[] {
  const sorted = [...times].sort((a, b) => a - b)
  let cursor = 0
  return monthEnds(now).map(({ label, shortLabel, end }) => {
    while (cursor < sorted.length && (sorted[cursor] ?? Infinity) <= end) cursor++
    return { label, shortLabel, value: cursor }
  })
}

function ownerKey(session: StudioSessionSummary): string | undefined {
  return session.owner === undefined || session.owner.id.trim() === '' ? undefined : `${session.owner.kind}:${session.owner.id}`
}

function skillsSection(agents: readonly StudioSummaryAgent[]): StudioDashboardSummary['skills'] {
  const skills = agents.flatMap(agent => agent.skills)
  const covered = agents.filter(agent => agent.skills.length > 0).length
  const invocable = skills.filter(skill => skill.modelInvocable).length
  const requiring = skills.filter(skill => skill.requiredTools.length > 0).length
  const tools = new Map<string, number>()
  for (const tool of skills.flatMap(skill => skill.requiredTools)) tools.set(tool, (tools.get(tool) ?? 0) + 1)
  const stats: StudioInsightStat[] = [
    { label: 'Agents Covered', value: `${String(covered)}/${String(agents.length)}`, hint: ratio(covered, agents.length) },
    { label: 'Model Invocable', value: `${String(invocable)}/${String(skills.length)}`, hint: ratio(invocable, skills.length) },
    { label: 'Require Tools', value: `${String(requiring)}/${String(skills.length)}`, hint: ratio(requiring, skills.length) },
  ]
  return { stats, agents: distribution(new Map(agents.map(agent => [agent.label, agent.skills.length])), skills.length), requiredTools: distribution(tools, skills.length) }
}

function sessionsSection(agents: readonly StudioSummaryAgent[]): StudioDashboardSummary['sessions'] {
  const sessions = agents.flatMap(agent => agent.sessions)
  const total = sessions.length
  const messages = sessions.reduce((sum, session) => sum + session.messageCount, 0)
  const covered = agents.filter(agent => agent.sessions.length > 0).length
  const users = new Set(sessions.flatMap(session => ownerKey(session) ?? []))
  const nonEmpty = sessions.filter(session => session.messageCount > 0).length
  const bands = new Map([['0 messages', 0], ['1-5 messages', 0], ['6-20 messages', 0], ['21+ messages', 0]])
  for (const { messageCount } of sessions) {
    const band = messageCount <= 0 ? '0 messages' : messageCount <= 5 ? '1-5 messages' : messageCount <= 20 ? '6-20 messages' : '21+ messages'
    bands.set(band, (bands.get(band) ?? 0) + 1)
  }
  const byAgent = agents
    .filter(agent => agent.sessions.length > 0)
    .map(agent => ({ label: agent.label, value: agent.sessions.length, hint: `${grouped(agent.sessions.reduce((sum, session) => sum + session.messageCount, 0))} msgs` }))
    .sort(byCountThenLabel)
    .slice(0, DISTRIBUTION_LIMIT)
  return {
    stats: [
      { label: 'Agents Covered', value: `${String(covered)}/${String(agents.length)}`, hint: ratio(covered, agents.length) },
      { label: 'Users Covered', value: grouped(users.size), hint: 'distinct users' },
      { label: 'Non-empty Sessions', value: `${String(nonEmpty)}/${String(total)}`, hint: ratio(nonEmpty, total) },
      { label: 'Avg Msg / Session', value: total > 0 ? studioRoundHalfEven(messages / total, 1).toFixed(1) : '0', hint: `${grouped(messages)} messages` },
    ],
    agents: byAgent,
    messageBands: [...bands].map(([label, value]) => ({ label, value, hint: ratio(value, total) })),
  }
}

function activity(agents: readonly StudioSummaryAgent[]): StudioActivityItem[] {
  const items: StudioActivityItem[] = []
  for (const agent of agents) {
    for (const skill of agent.skills) {
      if (skill.updatedAt !== undefined) items.push({ time: skill.updatedAt, kind: 'skill', agentId: agent.id, agentLabel: agent.label, text: `Skill ${skill.name} updated`, status: 'ok' })
    }
    for (const run of agent.evalRuns ?? []) {
      items.push({ time: run.startedAt, kind: 'eval', agentId: agent.id, agentLabel: agent.label, text: `Eval ${run.runId} (${String(run.passed)}/${String(run.total)} cases)`, status: run.passed === run.total ? 'ok' : 'warn' })
    }
    for (const session of agent.sessions) {
      const id = session.sessionId.replace(/^session-/u, '').slice(0, 8)
      items.push({ time: session.updatedAt, kind: 'session', agentId: agent.id, agentLabel: agent.label, text: `Session ${id} (${String(session.messageCount)} msgs)`, status: session.messageCount === 0 ? 'warn' : 'ok' })
    }
  }
  return items.sort((a, b) => b.time - a.time).slice(0, ACTIVITY_LIMIT)
}

/**
 * The static view.
 * @param allAgents - every agent the catalog serves, with its skills, tool count, and sessions.
 * @param now - the time the trends end at.
 */
export function studioDashboardSummary(allAgents: readonly StudioSummaryAgent[], now: number): StudioDashboardSummary {
  const agents = allAgents.map(agent => ({ ...agent, sessions: agent.sessions.filter(session => session.owner?.kind !== 'operator') }))
  const sessions = agents.flatMap(agent => agent.sessions)
  const firstSeen = new Map<string, number>()
  for (const session of sessions) {
    const owner = ownerKey(session)
    if (owner !== undefined) firstSeen.set(owner, Math.min(firstSeen.get(owner) ?? Infinity, session.updatedAt))
  }
  return {
    totalAgents: agents.length,
    totalUsers: firstSeen.size,
    totalSkills: agents.reduce((sum, agent) => sum + agent.skills.length, 0),
    totalTools: agents.reduce((sum, agent) => sum + agent.toolCount, 0),
    totalSessions: sessions.length,
    trends: {
      users: cumulativeTrend([...firstSeen.values()], now),
      skills: cumulativeTrend(agents.flatMap(agent => agent.skills.flatMap(skill => skill.updatedAt ?? [])), now),
      sessions: cumulativeTrend(sessions.map(session => session.updatedAt), now),
    },
    skills: skillsSection(agents),
    sessions: sessionsSection(agents),
    activity: activity(agents),
    generatedAt: now,
  }
}
