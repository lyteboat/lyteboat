/**
 * One turn's metric line, from the turn's outcome (`ctx.turnOutcome`) and the
 * skills the recorder saw active while the turn ran: the counts and timings as
 * the outcome folds them, the tool calls without dsh's `skill` tool (a skill
 * load is routing, not work the dashboard counts), and the outcome kind.
 * @module @lyteboat/turn-metrics/turn-metric
 */

import type { LyteboatTurnMetric, LyteboatTurnOutcome } from '@lyteboat/contracts'

/** dsh's tool that loads a skill. */
const SKILL_LOAD_TOOL = 'skill'

/** The skills active during one turn, as the recorder notes them event by event. */
export class TurnMetricSkills {
  readonly activated: string[] = []
  active: string | undefined

  /** The skill active after the latest event, as the session's projection folds it. */
  note(skill: string | null | undefined): void {
    if (skill === null || skill === undefined) return
    this.active = skill
    if (!this.activated.includes(skill)) this.activated.push(skill)
  }
}

/**
 * The metric line of one ended turn.
 * @param agentId - the preset the session runs.
 * @param sessionId - the session.
 * @param outcome - the turn as `lyteboatTurnOutcomes` folded it, ended.
 * @param skills - the skills active during the turn.
 */
export function turnMetricOf(agentId: string, sessionId: string, outcome: LyteboatTurnOutcome, skills: TurnMetricSkills): LyteboatTurnMetric {
  const durationMs = Math.max(0, (outcome.endedAt ?? outcome.startedAt) - outcome.startedAt)
  const owner = outcome.request?.owner
  return {
    agentId,
    sessionId,
    turn: outcome.turn,
    ...owner === undefined ? {} : { owner },
    startedAt: outcome.startedAt,
    durationMs,
    firstContentMs: outcome.firstContentAt === undefined ? durationMs : Math.max(0, outcome.firstContentAt - outcome.startedAt),
    steps: outcome.steps,
    modelRequests: outcome.modelRequests,
    auxCalls: outcome.auxCalls,
    tools: outcome.tools.filter(tool => tool.name !== SKILL_LOAD_TOOL).map(tool => ({
      name: tool.name,
      isError: tool.isError,
      ...tool.durationMs === undefined ? {} : { durationMs: tool.durationMs },
      ...tool.errorCode === undefined ? {} : { errorCode: tool.errorCode },
    })),
    activatedSkills: skills.activated,
    ...skills.active === undefined ? {} : { activeSkill: skills.active },
    outcome: outcome.kind ?? 'errored',
    ...outcome.error === undefined ? {} : { errorCode: outcome.error.code },
  }
}
