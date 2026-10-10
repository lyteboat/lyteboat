/**
 * The Dashboard's static view from agents, skills, tools, and sessions:
 * totals, six-month cumulative trends ending at the given time, the skills
 * and sessions sections with their shares, and the newest activities.
 */
import { describe, expect, it } from 'vitest'
import type { StudioSessionSummary } from '@lyteboat/contracts/studio'
import { studioDashboardSummary, type StudioSummaryAgent } from '../src/studio-dashboard-summary.ts'

const NOW = Date.UTC(2026, 8, 26, 12)
const month = (monthIndex: number, day = 15): number => Date.UTC(2026, monthIndex, day)

function session(id: string, owner: string | undefined, updatedAt: number, messageCount: number): StudioSessionSummary {
  const [kind, name] = (owner ?? ':').split(':') as ['user' | 'operator', string]
  return {
    sessionId: `session-${id}`, ...owner === undefined ? {} : { owner: { kind, id: name } }, createdAt: updatedAt, updatedAt, messageCount, turnCount: 1,
    errorCount: 0, rejectedCount: 0, abortedCount: 0, slowCount: 0, openTurn: false, seeded: false,
  }
}

const agents: StudioSummaryAgent[] = [
  {
    id: 'finance', label: '金融智能体', toolCount: 4,
    skills: [
      { name: 'asset-overview', modelInvocable: true, requiredTools: ['asset_overview'], updatedAt: month(8, 20) },
      { name: 'allocation-diagnosis', modelInvocable: true, requiredTools: ['allocation_diagnosis', 'asset_overview'], updatedAt: month(3) },
      { name: 'manual-only', modelInvocable: false, requiredTools: [] },
    ],
    sessions: [
      session('aaaaaaaa-1', 'user:alice', month(8, 25), 6),
      session('bbbbbbbb-2', 'user:alice', month(5), 2),
      session('cccccccc-3', 'user:bob', month(7), 25),
      session('dddddddd-4', undefined, month(1), 0),
    ],
  },
  { id: 'desk', label: 'Desk', toolCount: 2, skills: [{ name: 'desk-help', modelInvocable: true, requiredTools: [] }], sessions: [session('eeeeeeee-5', 'user:carol', month(8, 24), 3)] },
  { id: 'idle', label: 'Idle', toolCount: 0, skills: [], sessions: [] },
]

describe('studioDashboardSummary', () => {
  const summary = studioDashboardSummary(agents, NOW)

  it('counts the agents, users by owner, skills, reachable tools, and sessions', () => {
    expect(summary).toMatchObject({ totalAgents: 3, totalUsers: 3, totalSkills: 4, totalTools: 6, totalSessions: 5, generatedAt: NOW })
  })

  it('leaves out test-window sessions, which an operator owns', () => {
    const tried = studioDashboardSummary([{ ...agents[2]!, sessions: [session('ffffffff-6', 'operator:editor', month(8, 25), 4)] }], NOW)
    expect(tried).toMatchObject({ totalUsers: 0, totalSessions: 0, activity: [] })
  })

  it('draws six cumulative months ending with the current one', () => {
    expect(summary.trends.sessions).toEqual([
      { label: '2026-04', shortLabel: '04', value: 1 },
      { label: '2026-05', shortLabel: '05', value: 1 },
      { label: '2026-06', shortLabel: '06', value: 2 },
      { label: '2026-07', shortLabel: '07', value: 2 },
      { label: '2026-08', shortLabel: '08', value: 3 },
      { label: '2026-09', shortLabel: '09', value: 5 },
    ])
    expect(summary.trends.users.map(point => point.value)).toEqual([0, 0, 1, 1, 2, 3])
    expect(summary.trends.skills.map(point => point.value)).toEqual([1, 1, 1, 1, 1, 2])
  })

  it('shows the skills per agent and the tools skills require, with their shares', () => {
    expect(summary.skills.stats).toEqual([
      { label: 'Agents Covered', value: '2/3', hint: '67%' },
      { label: 'Model Invocable', value: '3/4', hint: '75%' },
      { label: 'Require Tools', value: '2/4', hint: '50%' },
    ])
    expect(summary.skills.agents).toEqual([{ label: '金融智能体', value: 3, hint: '75%' }, { label: 'Desk', value: 1, hint: '25%' }])
    expect(summary.skills.requiredTools).toEqual([{ label: 'asset_overview', value: 2, hint: '50%' }, { label: 'allocation_diagnosis', value: 1, hint: '25%' }])
  })

  it('shows the sessions coverage and message bands as the original Studio does', () => {
    expect(summary.sessions.stats).toEqual([
      { label: 'Agents Covered', value: '2/3', hint: '67%' },
      { label: 'Users Covered', value: '3', hint: 'distinct users' },
      { label: 'Non-empty Sessions', value: '4/5', hint: '80%' },
      { label: 'Avg Msg / Session', value: '7.2', hint: '36 messages' },
    ])
    expect(summary.sessions.agents).toEqual([{ label: '金融智能体', value: 4, hint: '33 msgs' }, { label: 'Desk', value: 1, hint: '3 msgs' }])
    expect(summary.sessions.messageBands.map(band => [band.label, band.value])).toEqual([['0 messages', 1], ['1-5 messages', 2], ['6-20 messages', 1], ['21+ messages', 1]])
  })

  it('lists the newest activities first, a session without messages as a warning', () => {
    expect(summary.activity.slice(0, 3).map(item => [item.kind, item.text, item.status])).toEqual([
      ['session', 'Session aaaaaaaa (6 msgs)', 'ok'],
      ['session', 'Session eeeeeeee (3 msgs)', 'ok'],
      ['skill', 'Skill asset-overview updated', 'ok'],
    ])
    expect(summary.activity.find(item => item.text.startsWith('Session dddddddd'))?.status).toBe('warn')
  })

  it('answers zeros for no agents', () => {
    const empty = studioDashboardSummary([], NOW)

    expect(empty).toMatchObject({ totalAgents: 0, totalSessions: 0, activity: [] })
    expect(empty.sessions.stats.find(stat => stat.label === 'Avg Msg / Session')?.value).toBe('0')
    expect(empty.skills.stats[0]).toEqual({ label: 'Agents Covered', value: '0/0', hint: '0%' })
  })
})
