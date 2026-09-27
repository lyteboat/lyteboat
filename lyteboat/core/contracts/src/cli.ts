/**
 * The JSON the lyteboat launcher prints for scripts and for the Studio, which
 * reads another process's output: `lyteboat inspect --result json` (what an
 * agent is made of, once mounted) and `lyteboat try --result json` (one turn).
 * Types, the rule ids of a skill's deterministic checks, the row ids of the
 * mode runners the launcher checks, and the zod schemas a reader validates that
 * output with; no other runtime behavior.
 * @module @lyteboat/contracts/cli
 */

import { z } from 'zod'
import { LYTEBOAT_TURN_OUTCOMES, lyteboatAgentIdentitySchema, lyteboatAgentModelSchema } from './index.ts'
import type { LyteboatAgentIdentity, LyteboatAgentModel, LyteboatTurnOutcome } from './index.ts'
import type { StudioSkillRouting, StudioTool } from './studio.ts'

/**
 * The row ids of lyteboat's mode runners, as the mode bundles insert them. The
 * launcher (and the composition harness, which mirrors it) fails a startup that
 * leaves an enabled one inactive.
 */
export const LYTEBOAT_MODE_RUNNER_IDS = ['lyteboat-try', 'lyteboat-serve', 'lyteboat-eval', 'lyteboat-studio', 'lyteboat-inspect'] as const

/**
 * A skill's deterministic checks: its lyteboat metadata parses; every tool it
 * requires is registered, and declared (the router activates only declared
 * tools); a required tool is `auto` (an `always` one is visible anyway); a
 * routed agent can pick it.
 */
export const LYTEBOAT_SKILL_FINDING_RULES = ['metadata-valid', 'required-tools-registered', 'required-tools-declared', 'required-tools-auto', 'routable'] as const

/** One of {@link LYTEBOAT_SKILL_FINDING_RULES}. */
export type LyteboatSkillFindingRule = typeof LYTEBOAT_SKILL_FINDING_RULES[number]

/** One check of one skill; a reader words it from the rule and its subjects. */
export type LyteboatSkillFinding = {
  rule: LyteboatSkillFindingRule
  /** How much a failure matters: `error` breaks a turn that activates the skill, `warn` does not. */
  level: 'error' | 'warn'
  passed: boolean
  /** The tools a tool rule failed on; empty when it passed or is not about tools. */
  tools: string[]
  /** Why the metadata does not parse (`metadata-valid`). */
  problem?: string
}

/** One skill of an agent, with the tools its lyteboat metadata requires. */
export type LyteboatInspectedSkill = {
  name: string
  description: string
  whenToUse?: string
  modelInvocable: boolean
  userInvocable: boolean
  requiredTools: string[]
  /** Why its lyteboat metadata cannot be read. */
  metadataProblem?: string
  /** The absolute path of its SKILL.md, when a file provides it. */
  file?: string
}

/** A case file of an agent's `evals/`, relative to the agent directory. */
export type LyteboatInspectedCaseFile = {
  file: string
  /** The case ids, in file order; empty when the file does not load. */
  cases: string[]
  error?: string
}

/** `lyteboat inspect`: an agent that mounted, with what reaches its model. */
export type LyteboatInspectMounted = {
  agent: string
  mounted: true
  identity: LyteboatAgentIdentity
  tools: StudioTool[]
  skills: LyteboatInspectedSkill[]
  routing: StudioSkillRouting
  /** Every skill's checks, in skill order. */
  findings: { skill: string; findings: LyteboatSkillFinding[] }[]
  cases: LyteboatInspectedCaseFile[]
}

/** `lyteboat inspect`: an agent that did not mount, and why. */
export type LyteboatInspectUnmounted = {
  agent: string
  mounted: false
  failure: string
  cases: LyteboatInspectedCaseFile[]
}

/** What `lyteboat inspect --result json` prints. */
export type LyteboatInspectResult = LyteboatInspectMounted | LyteboatInspectUnmounted

/** What `lyteboat try --result json` prints: the one turn it ran. */
export type LyteboatTryResult = {
  sessionId: string
  outcome: LyteboatTurnOutcome
  /** The reply's text, cards as their `[card <area>]` lines. */
  text: string
  /** The areas of the cards the turn placed, in order. */
  cards: string[]
  /** The tools the model called, in call order. */
  tools: string[]
  /** The skill active when the turn ended. */
  skill?: string
  model: LyteboatAgentModel
}

const lyteboatSkillFindingSchema: z.ZodType<LyteboatSkillFinding> = z.strictObject({
  rule: z.enum(LYTEBOAT_SKILL_FINDING_RULES),
  level: z.enum(['error', 'warn']),
  passed: z.boolean(),
  tools: z.array(z.string()),
  problem: z.string().exactOptional(),
})

const lyteboatInspectedSkillSchema: z.ZodType<LyteboatInspectedSkill> = z.strictObject({
  name: z.string(),
  description: z.string(),
  whenToUse: z.string().exactOptional(),
  modelInvocable: z.boolean(),
  userInvocable: z.boolean(),
  requiredTools: z.array(z.string()),
  metadataProblem: z.string().exactOptional(),
  file: z.string().exactOptional(),
})

const lyteboatInspectedToolSchema: z.ZodType<StudioTool> = z.strictObject({
  name: z.string(),
  description: z.string(),
  parameters: z.record(z.string(), z.unknown()),
  declared: z.enum(['always', 'auto', 'inherited']),
  reach: z.enum(['always', 'activated', 'hidden']),
  requiredBy: z.array(z.string()),
})

const lyteboatInspectedCaseFileSchema: z.ZodType<LyteboatInspectedCaseFile> = z.strictObject({
  file: z.string(),
  cases: z.array(z.string()),
  error: z.string().exactOptional(),
})

/** The schema of {@link LyteboatInspectResult}. */
export const lyteboatInspectResultSchema: z.ZodType<LyteboatInspectResult> = z.discriminatedUnion('mounted', [
  z.strictObject({
    agent: z.string(),
    mounted: z.literal(true),
    identity: lyteboatAgentIdentitySchema,
    tools: z.array(lyteboatInspectedToolSchema),
    skills: z.array(lyteboatInspectedSkillSchema),
    routing: z.strictObject({ mode: z.enum(['off', 'full', 'dynamic']), provider: z.string().exactOptional(), model: z.string().exactOptional() }),
    findings: z.array(z.strictObject({ skill: z.string(), findings: z.array(lyteboatSkillFindingSchema) })),
    cases: z.array(lyteboatInspectedCaseFileSchema),
  }),
  z.strictObject({
    agent: z.string(),
    mounted: z.literal(false),
    failure: z.string(),
    cases: z.array(lyteboatInspectedCaseFileSchema),
  }),
])

/** The schema of {@link LyteboatTryResult}. */
export const lyteboatTryResultSchema: z.ZodType<LyteboatTryResult> = z.strictObject({
  sessionId: z.string().min(1),
  outcome: z.enum(LYTEBOAT_TURN_OUTCOMES),
  text: z.string(),
  cards: z.array(z.string()),
  tools: z.array(z.string()),
  skill: z.string().exactOptional(),
  model: lyteboatAgentModelSchema,
})
