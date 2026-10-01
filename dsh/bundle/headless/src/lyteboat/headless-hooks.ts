/**
 * lyteboat's extension of the one-shot runner (dsh-compat/contract/extensions.yml:
 * `headless-hooks`): the three waterfalls the runner dispatches around one
 * run (before it creates or adopts the Agent, when it submits the task, and
 * before it prints the outcome) and the plans they carry. A listener edits the
 * plan and calls `next()`; the runner carries out the plan the waterfall
 * leaves, so a listener never skips another one, and with no listener the plan
 * is the official runner's. A plugin that listens declares
 * `inject: ['lyteboatDistro']`.
 * @module @deepseek-ai/dsh-headless/lyteboat/headless-hooks
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentSetup, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import { SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'

/** How the runner creates or adopts the Agent; the payload of `lyteboat/headless-start`. */
export interface LyteboatHeadlessStartPlan {
  /** The stored Session the invocation continues; absent for a new Session. */
  readonly resumeSessionId: SessionId | undefined
  /** Where a new Session is recorded and where a continued one must have been. Default: the filesystem's working directory. */
  cwd: string
  /**
   * The agent preset a new Session records and a continued one must run under.
   * The listener that sets it also joins the preset in {@link setup}. Default: none.
   */
  agentPreset: string | undefined
  /** Per-Agent scope setup. Default: installs the run's model selection; a listener wraps it. */
  setup: AgentSetup
  /** Closed turns a new Session starts from, as `seed` of `agents.create`; a continued Session takes none. Default: none. */
  seed: readonly SessionEvent[] | undefined
}

/** How the runner submits the task; the payload of `lyteboat/headless-submit`. */
export interface LyteboatHeadlessSubmitPlan {
  readonly agent: Agent
  /** The task text, from the command line or stdin. */
  readonly task: string
  /** Hands the task to the Agent. Default: follows up one user message whose source is `{ kind: 'user' }`. */
  deliver: () => Promise<void>
}

/** What the runner prints; the payload of `lyteboat/headless-report`. */
export interface LyteboatHeadlessReportPlan {
  readonly agent: Agent
  /** The Session offset this run's interval starts at. */
  readonly firstSeq: SessionLogOffset
  /** How the run's last turn ended; absent when none ended. The runner's exit code follows it. */
  readonly reason: SessionEvent<'turn/end'>['data']['reason'] | undefined
  /** The answer stdout carries (with `--json`, the final event's text). Default: the interval's last assistant text. */
  text: string
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Dispatched once the task is read and the model selected, before the
     * runner creates the Agent or adopts the stored Session.
     * @mode waterfall
     */
    'lyteboat/headless-start'(plan: LyteboatHeadlessStartPlan, next: () => Promise<void>): Promise<void>
    /**
     * Dispatched once the Agent is idle and the run's observers are attached,
     * before the task reaches the Agent.
     * @mode waterfall
     */
    'lyteboat/headless-submit'(plan: LyteboatHeadlessSubmitPlan, next: () => Promise<void>): Promise<void>
    /**
     * Dispatched after the Session is flushed and the outcome read, before
     * anything is printed.
     * @mode waterfall
     */
    'lyteboat/headless-report'(plan: LyteboatHeadlessReportPlan, next: () => Promise<void>): Promise<void>
  }
}

/**
 * Settle the start plan.
 * @param ctx - the runner's context.
 * @param plan - the official runner's plan.
 * @returns the plan the listeners left.
 */
export async function planHeadlessStart(ctx: Context, plan: LyteboatHeadlessStartPlan): Promise<LyteboatHeadlessStartPlan> {
  await ctx.waterfall('lyteboat/headless-start', plan, () => Promise.resolve())
  if (plan.resumeSessionId !== undefined && plan.seed !== undefined) {
    throw new Error(`session "${plan.resumeSessionId}" is continued, so it takes no seed; a seed starts a new Session`)
  }
  return plan
}

/**
 * The creation options a start plan gives a new Session: the official
 * runner's `{ cwd }` when no listener changed it.
 * @param plan - the settled start plan.
 * @returns `meta`, and the seed with its inherited length when there is one.
 */
export function createOptionsOfStart(plan: LyteboatHeadlessStartPlan): Pick<CreateAgentOptions, 'meta' | 'seed' | 'inheritedEventCount'> {
  const seed = plan.seed !== undefined && plan.seed.length > 0 ? plan.seed : undefined
  return {
    meta: {
      cwd: plan.cwd,
      ...plan.agentPreset === undefined ? {} : { agentPreset: plan.agentPreset },
      ...seed === undefined ? {} : { isSeeded: true },
    },
    ...seed === undefined ? {} : { seed, inheritedEventCount: SessionLogOffset(seed.length) },
  }
}

/**
 * Settle the submit plan.
 * @param ctx - the runner's context.
 * @param plan - the official runner's plan.
 * @returns the plan the listeners left.
 */
export async function planHeadlessSubmit(ctx: Context, plan: LyteboatHeadlessSubmitPlan): Promise<LyteboatHeadlessSubmitPlan> {
  await ctx.waterfall('lyteboat/headless-submit', plan, () => Promise.resolve())
  return plan
}

/**
 * Settle the report plan.
 * @param ctx - the runner's context.
 * @param plan - the official runner's plan.
 * @returns the plan the listeners left.
 */
export async function planHeadlessReport(ctx: Context, plan: LyteboatHeadlessReportPlan): Promise<LyteboatHeadlessReportPlan> {
  await ctx.waterfall('lyteboat/headless-report', plan, () => Promise.resolve())
  return plan
}

/**
 * The refusal of a stored Session whose preset is not the one a start plan composes.
 * @param sessionId - the stored Session.
 * @param stored - the preset it runs under, if any.
 * @param planned - the preset the plan composes.
 * @returns the error the runner throws.
 */
export function presetMismatchOf(sessionId: SessionId, stored: string | undefined, planned: string): Error {
  return new Error(stored === undefined
    ? `session "${sessionId}" runs under no agent preset, so it cannot be continued under agent preset "${planned}"`
    : `session "${sessionId}" runs under agent preset "${stored}", so it cannot be continued under agent preset "${planned}"`)
}
