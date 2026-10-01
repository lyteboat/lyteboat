/**
 * @lyteboat/headless — the business one-shot: dsh's one-shot runner
 * (`@deepseek-ai/dsh-headless`) runs the task, and this row listens to the
 * runner's plans (the kernel extension `headless-hooks`). Before the Agent
 * exists it composes the selected agent (its preset, joined in the setup
 * window), moves the session into the agent's working directory, and seeds an
 * imported history; it submits the task through `intakeGuard.submit` with its
 * request context; and it prints the turn with its cards placed (each as a
 * `[card <area>]` line), or with `result: json` as one
 * {@link LyteboatHeadlessResult} object, and the session id to stderr. It
 * publishes `headlessStartup`, which the runner row injects, only once it
 * listens, so the runner never starts a business run this row does not shape.
 * @module @lyteboat/headless
 */

import { mkdirSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, AgentSetup } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type { HeadlessStartupValues } from '@deepseek-ai/dsh-headless/startup'
import type { LyteboatHeadlessReportPlan } from '@deepseek-ai/dsh-headless'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionLogOffset } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { LyteboatTurnPart } from '@lyteboat/a2ui'
import { LYTEBOAT_ASSISTANT_PROVIDER, LYTEBOAT_TURN_OUTCOME_OF_REASON } from '@lyteboat/contracts'
import type { JsonValue, LyteboatAgentIdentity, LyteboatRequestOwner, LyteboatTurnOutcome } from '@lyteboat/contracts'
import type { LyteboatHeadlessResult } from '@lyteboat/contracts/cli'
import type {} from '@lyteboat/agent-catalog'
import type {} from '@lyteboat/history-import'
import type {} from '@lyteboat/intake-guard'

/** Who a task typed at the command line comes from. */
const CLI_OWNER: LyteboatRequestOwner = { kind: 'operator', id: 'cli' }

/** The service the runner row injects (`@deepseek-ai/dsh-headless/startup`'s `HEADLESS_STARTUP_SERVICE`). */
const HEADLESS_STARTUP_SERVICE = 'headlessStartup'

/** Plugin config: the run resolved from the startup provider service. */
export interface LyteboatHeadlessConfig {
  /** The task text; absent when the runner reads stdin. */
  task?: string
  /** A stored session to continue; it must run under `agent` (or under none, without one). */
  sessionId?: string
  /** Whether stdout carries dsh's event stream instead of the turn. */
  json?: boolean
  /** The agent to compose from (its agent preset id, declared by the agent catalog); absent runs the business base alone. */
  agent?: string
  /** An external history file (entries grouped into rounds) seeded into a new session as closed turns. */
  history?: string
  /** The request context the task carries; absent keeps a continued session's earlier context. */
  context?: { [key: string]: JsonValue }
  /** How the turn is printed: the answer as text, or one {@link LyteboatHeadlessResult} object. */
  result?: 'text' | 'json'
}

/**
 * The tools the model called in the owned interval, and whether an answer came
 * from the admission in the loop (a completed turn it answered is `rejected`).
 */
function calledIn(agent: Agent, firstSeq: SessionLogOffset): { tools: string[]; answeredInLoop: boolean } {
  const tools: string[] = []
  let answeredInLoop = false
  for (let seq = firstSeq; seq < agent.session.seq; seq++) {
    const event = agent.session.eventAt(SessionSeq(seq))
    if (event?.type !== 'assistant/message') continue
    if (event.data.message.source.provider === LYTEBOAT_ASSISTANT_PROVIDER) answeredInLoop = true
    for (const block of event.data.message.content) if (block.type === 'tool-call') tools.push(block.name)
  }
  return { tools, answeredInLoop }
}

/** A turn as the terminal shows it: text as written, each card as its own `[card <area>]` line. */
function renderTurn(parts: readonly LyteboatTurnPart[]): string {
  let out = ''
  for (const part of parts) {
    if (part.kind === 'text') out += part.text
    else out += `${out === '' || out.endsWith('\n') ? '' : '\n'}[card ${part.card.area}]\n`
  }
  return out.replace(/\n+$/u, '')
}

export default class LyteboatHeadlessHooks {
  // lyteboatDistro: the plans ride the kernel extension headless-hooks.
  static inject = ['lyteboatDistro', 'agentDefaultModel', 'agentPresets', 'agentCatalog', 'sessionProjections', 'historyImport', 'a2ui', 'intakeGuard']
  static Config: z<LyteboatHeadlessConfig> = z.object({
    task: z.string(),
    sessionId: z.string(),
    json: z.boolean(),
    agent: z.string(),
    history: z.string(),
    context: z.dict(z.any()),
    result: z.union(['text', 'json'] as const).default('text'),
  })

  /** The selected agent's identity, recorded on the request; set when the start plan composes it. */
  private identity: LyteboatAgentIdentity | undefined

  /**
   * Listen to the runner's three plans, then let the runner start.
   * @param ctx - plugin context carrying the agent catalog, preset registry, and request services.
   * @param headlessConfig - the run, from the startup provider.
   */
  constructor(private readonly ctx: Context, headlessConfig: LyteboatHeadlessConfig) {
    ctx.on('lyteboat/headless-start', async (plan, next) => {
      if (headlessConfig.agent !== undefined) await this.composeAgent(plan, headlessConfig.agent)
      if (headlessConfig.history !== undefined) {
        const history = ctx.historyImport.readFile(headlessConfig.history)
        const seed = ctx.historyImport.seed(history.rounds)
        // This row speaks for the business run on stderr, beside the runner's own `dsh:` lines.
        process.stderr.write(`lyteboat: imported ${String(seed.imported.length)} history round(s) from ${history.source}\n`)
        if (seed.events.length > 0) plan.seed = seed.events
      }
      await next()
    })
    ctx.on('lyteboat/headless-submit', async (plan, next) => {
      // Admission runs before the request enters the loop, so its verdict is recorded with the request.
      plan.deliver = async () => {
        await ctx.intakeGuard.submit(plan.agent, { text: plan.task, context: headlessConfig.context, owner: CLI_OWNER, agent: this.identity }, new AbortController().signal)
      }
      await next()
    })
    ctx.on('lyteboat/headless-report', async (plan, next) => {
      const parts = ctx.a2ui.turnParts(plan.agent.session, plan.firstSeq)
      plan.text = headlessConfig.result === 'json' ? JSON.stringify(this.resultOf(plan, parts)) : renderTurn(parts)
      process.stderr.write(`lyteboat: session ${plan.agent.session.id}\n`)
      await next()
    })
    ctx.provide(HEADLESS_STARTUP_SERVICE, {
      task: headlessConfig.task,
      sessionId: headlessConfig.sessionId,
      json: headlessConfig.json === true,
    } satisfies HeadlessStartupValues)
  }

  /** Compose `agentId` into the start plan: its preset in the setup window, its working directory. */
  private async composeAgent(plan: { cwd: string; agentPreset: string | undefined; setup: AgentSetup }, agentId: string): Promise<void> {
    const { agentCatalog, agentPresets } = this.ctx
    await agentCatalog.whenReady()
    const preset = (await agentPresets.resolve(agentId)).id
    const entry = agentCatalog.get(preset)
    if (entry === undefined) throw new Error(`lyteboat headless: agent "${preset}" is not in the agent catalog`)
    // An agent's sessions live in its working directory, so a later run continues one from any directory.
    // Unlike the session controller, dsh's agent registry does not create a session's directory.
    mkdirSync(entry.workdir, { recursive: true })
    this.identity = entry.identity
    const setup = plan.setup
    plan.cwd = entry.workdir
    plan.agentPreset = preset
    plan.setup = async (agentCtx, agent) => {
      const commit = await setup(agentCtx, agent)
      await agentPresets.mount(agentCtx, preset)
      return commit
    }
  }

  /** The turn as one object, as `--result json` prints it. */
  private resultOf(plan: LyteboatHeadlessReportPlan, parts: readonly LyteboatTurnPart[]): LyteboatHeadlessResult {
    const { tools, answeredInLoop } = calledIn(plan.agent, plan.firstSeq)
    const ended: LyteboatTurnOutcome = plan.reason === undefined ? 'errored' : LYTEBOAT_TURN_OUTCOME_OF_REASON[plan.reason.kind] ?? 'errored'
    const skill = this.ctx.sessionProjections.stateOf(plan.agent.session, 'lyteboatActiveSkill')?.active ?? undefined
    const model = this.ctx.agentDefaultModel.currentSelection()
    return {
      sessionId: plan.agent.session.id,
      outcome: ended === 'completed' && answeredInLoop ? 'rejected' : ended,
      text: renderTurn(parts),
      cards: parts.flatMap(part => part.kind === 'card' ? [part.card.area] : []),
      tools,
      ...skill === undefined ? {} : { skill },
      model: { provider: model.provider, model: model.model },
    }
  }
}
