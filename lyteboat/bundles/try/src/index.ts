/**
 * @lyteboat/try — lyteboat's one-shot mode. The bundle patch rides over
 * dsh-base; this runner creates one Agent through the core registry — composed
 * from an agent preset when the invocation named one — or resumes a stored
 * session, drives the task to quiescence, streams provider reasoning to stderr,
 * flushes its Session, prints the turn to stdout (the answer with its cards
 * placed, each as a `[card <area>]` line; with `result: json`, one
 * {@link LyteboatTryResult} object instead) and the session id to stderr, and
 * exits.
 *
 * Modeled on deepseek-ai/deepseek-harness packages/bundle/headless/src/index.ts
 * @ dsh-v0.1.7-rc.2 (477b4f42), MIT — see THIRD_PARTY_NOTICES.md. Differences:
 * the agent composition (the selected agent, declared to the preset registry by
 * `@lyteboat/agent-catalog`, joined through `agentPresets.mount` in the setup window;
 * without `--agent` no preset, and a session that ran under one is refused), a
 * resumed session continuing under the agent it ran under, an imported
 * history seeded into a new session, the task submitted through
 * `intakeGuard.submit` with its request context, the turn printed with its
 * cards placed or as one result object, no stdin task and no `--json` event
 * stream, and the `lyteboat:` diagnostic prefix.
 * @module @lyteboat/try
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentRegistry, AgentSetup, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type { LyteboatTurnPart } from '@lyteboat/a2ui'
import { LYTEBOAT_ASSISTANT_PROVIDER, LYTEBOAT_TURN_OUTCOME_OF_REASON } from '@lyteboat/contracts'
import type { JsonValue, LyteboatAgentIdentity, LyteboatRequestOwner, LyteboatTurnOutcome } from '@lyteboat/contracts'
import type { LyteboatTryResult } from '@lyteboat/contracts/cli'
import type {} from '@lyteboat/history-import'
import type {} from '@lyteboat/agent-catalog'
import type {} from '@lyteboat/intake-guard'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { SessionQueryError } from '@deepseek-ai/dsh-session-query'
import type { SeedResult } from '@lyteboat/history-import'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-cmdline'

/** Who a task typed at the command line comes from. */
const CLI_OWNER: LyteboatRequestOwner = { kind: 'operator', id: 'cli' }

/** Plugin config: the task and agent resolved from the startup provider service. */
export interface LyteboatTryConfig {
  /** The prompt text for the single run. */
  task: string
  /** The agent to compose from (its agent preset id, declared by the agent catalog); absent runs the host composition alone. */
  agent?: string
  /** An external history file (entries grouped into rounds) seeded into the session as closed turns before the task. */
  history?: string
  /** A stored session to continue; it must run under `agent` (or under none, without one), and a session without an agent must belong to this directory. */
  sessionId?: string
  /** The request context the task carries; absent keeps a continued session's earlier context. */
  context?: { [key: string]: JsonValue }
  /** How the turn is printed: the answer as text, or one {@link LyteboatTryResult} object. */
  result?: 'text' | 'json'
}

interface RunIo {
  stdout: { write(chunk: string): unknown }
  stderr: { write(chunk: string): unknown }
  exit(code: number): void
}

/** The turn outcome of one owned interval. */
function summarize(session: Session, firstSeq: SessionLogOffset): SessionEvent<'turn/end'>['data']['reason'] | undefined {
  let started = false
  let reason: SessionEvent<'turn/end'>['data']['reason'] | undefined
  const length = session.seq
  for (let seq = firstSeq; seq < length; seq++) {
    const event = session.eventAt(SessionSeq(seq))
    if (event === undefined) {
      throw new Error(`lyteboat try summary cannot read seq ${String(seq)} below captured length ${String(length)}`)
    }
    if (event.type === 'turn/start') {
      started = true
      continue
    }
    if (started && event.type === 'turn/end') reason = event.data.reason
  }
  return reason
}

/**
 * The tools the model called in the owned interval, and whether an answer came
 * from the admission in the loop (a completed turn it answered is `rejected`).
 */
function calledIn(session: Session, firstSeq: SessionLogOffset): { tools: string[]; answeredInLoop: boolean } {
  const tools: string[] = []
  let answeredInLoop = false
  for (let seq = firstSeq; seq < session.seq; seq++) {
    const event = session.eventAt(SessionSeq(seq))
    if (event?.type !== 'assistant/message') continue
    if (event.data.message.source.provider === LYTEBOAT_ASSISTANT_PROVIDER) answeredInLoop = true
    for (const block of event.data.message.content) if (block.type === 'tool-call') tools.push(block.name)
  }
  return { tools, answeredInLoop }
}

/** The turn as one object, as `--result json` prints it. */
function tryResultOf(ctx: Context, agent: Agent, firstSeq: SessionLogOffset, parts: readonly LyteboatTurnPart[], reason: SessionEvent<'turn/end'>['data']['reason'] | undefined, model: { provider: string; model: string }): LyteboatTryResult {
  const { tools, answeredInLoop } = calledIn(agent.session, firstSeq)
  const ended: LyteboatTurnOutcome = reason === undefined ? 'errored' : LYTEBOAT_TURN_OUTCOME_OF_REASON[reason.kind] ?? 'errored'
  const skill = ctx.sessionProjections.stateOf(agent.session, 'lyteboatActiveSkill')?.active ?? undefined
  return {
    sessionId: agent.session.id,
    outcome: ended === 'completed' && answeredInLoop ? 'rejected' : ended,
    text: renderTurn(parts),
    cards: parts.flatMap(part => part.kind === 'card' ? [part.card.area] : []),
    tools,
    ...skill === undefined ? {} : { skill },
    model: { provider: model.provider, model: model.model },
  }
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

/** Project provider-reported reasoning from one owned run to stderr as it streams. */
function streamReasoning(ctx: Context, agent: Agent, stderr: RunIo['stderr']): () => void {
  let open = false
  let endsWithNewline = true
  const close = (): void => {
    if (!open) return
    if (!endsWithNewline) stderr.write('\n')
    open = false
    endsWithNewline = true
  }
  const dispose = ctx.on('agent/assistant-stream', ({ agent: subject, frame }) => {
    if (subject !== agent) return
    if (frame.type === 'start' || frame.type === 'end') {
      close()
      return
    }
    const chunk = frame.chunk
    switch (chunk.type) {
      case 'reasoning-delta':
        if (chunk.text === '') return
        if (!open) {
          stderr.write('lyteboat: reasoning:\n')
          open = true
        }
        stderr.write(chunk.text)
        endsWithNewline = chunk.text.endsWith('\n')
        return
      case 'block-start':
        if (chunk.blockType !== 'reasoning') close()
        return
      case 'block-end':
        if (chunk.block.type !== 'reasoning') close()
        return
      case 'usage':
        return
      case 'text-delta':
      case 'tool-call-delta':
      case 'finish':
        close()
        return
      /* v8 ignore next -- closed-union exhaustiveness guard */
      default:
        return assertNever(chunk, 'lyteboat try reasoning stream')
    }
  })
  return () => {
    dispose()
    close()
  }
}

/** The agent a stored session runs under: its creation header, advanced by every later selection. */
function storedPreset(header: SessionHeader, events: readonly SessionEvent[]): string | undefined {
  let preset = header.agentPreset
  for (const event of events) {
    if (event.type === 'agent-preset/selected') preset = event.data.agentPreset
  }
  return preset
}

/** Refuse a stored session this invocation cannot continue as it was run. */
function assertContinuable(header: SessionHeader, events: readonly SessionEvent[], sessionId: SessionId, agentPreset: string | undefined, cwd: string): void {
  const stored = storedPreset(header, events)
  if (stored !== agentPreset) {
    throw new Error(stored === undefined
      ? `session "${sessionId}" runs without an agent; continue it without --agent`
      : `session "${sessionId}" runs under agent "${stored}"; continue it with --agent ${stored}`)
  }
  if (header.origin === 'subagent' || header.parentSession !== undefined) throw new Error(`session "${sessionId}" is a subagent or forked session and cannot be continued directly`)
  if (header.cwd !== cwd) throw new Error(`session "${sessionId}" was recorded in "${header.cwd ?? 'no directory'}", not "${cwd}"`)
}

/**
 * Continue a stored session. The id must exist: a typo must not pass as a new
 * conversation, so a first round omits `--session-id` instead.
 * @param ctx - the runner's context, carrying the session query service.
 * @param agents - the core agent registry.
 * @param options - the stored identity, the agent it must run under, and the agent's options and setup.
 */
async function resumeAgent(
  ctx: Context,
  agents: AgentRegistry,
  options: { sessionId: SessionId; agentPreset: string | undefined; cwd: string; agentOptions: { provider: string; model: string }; setup: AgentSetup },
): Promise<Agent> {
  const { sessionId, agentPreset, cwd, agentOptions, setup } = options
  try {
    using observation = await ctx.sessionQuery.observeSession(sessionId)
    assertContinuable(observation.header, observation.events, sessionId, agentPreset, cwd)
  } catch (error: unknown) {
    if (error instanceof SessionQueryError && error.code === 'SESSION_QUERY_SESSION_NOT_FOUND') {
      throw new Error(`session "${sessionId}" does not exist; omit --session-id to start a new session`, { cause: error })
    }
    throw error
  }
  const { agent } = await agents.resume({ resumeSessionId: sessionId, agentOptions, setup })
  return agent
}

function fail(io: RunIo, error: unknown): void {
  io.stderr.write(`lyteboat: ${error instanceof Error ? error.message : String(error)}\n`)
  io.exit(1)
}

/**
 * Run one task through a freshly created Agent and request process exit.
 * @param ctx - plugin context carrying the Agent, default model, Session, and launcher IO services.
 * @param config - the task and optional agent.
 * @param io - process-facing effects.
 */
async function run(ctx: Context, config: LyteboatTryConfig, io: RunIo): Promise<void> {
  await ctx.get('loader')?.await()
  // Injected, so present while this row is active; a tree disposed during the
  // settlement above makes these reads throw, and the failure still exits.
  const { agents, agentDefaultModel, agentPresets: presets, agentCatalog, sessions, historyImport, a2ui, intakeGuard } = ctx

  const selection = agentDefaultModel.currentSelection()
  let agentPreset: string | undefined
  // An agent's sessions live in its working directory, so a later run continues
  // one from any directory; a run without an agent stays where it was started.
  let cwd = process.cwd()
  let identity: LyteboatAgentIdentity | undefined
  if (config.agent !== undefined) {
    await agentCatalog.whenReady()
    agentPreset = (await presets.resolve(config.agent)).id
    const entry = agentCatalog.get(agentPreset)
    if (entry === undefined) throw new Error(`lyteboat try: agent "${agentPreset}" is not in the agent catalog`)
    cwd = entry.workdir
    identity = entry.identity
    // Unlike the session controller, dsh's agent registry does not create a session's directory.
    mkdirSync(cwd, { recursive: true })
  }
  const setup: AgentSetup = async (agentCtx) => {
    const selected: ModelSelectionRef = { current: selection, assembled: undefined }
    installModelSelection(agentCtx, selected)
    if (agentPreset !== undefined) await presets.mount(agentCtx, agentPreset)
  }
  // History arrives as a seed: closed turns the agent loop counts from, so the task
  // becomes turn N+1 and the first request already derives the imported rounds.
  let seed: SeedResult | undefined
  if (config.history !== undefined) {
    const history = historyImport.readFile(config.history)
    seed = historyImport.seed(history.rounds)
    io.stderr.write(`lyteboat: imported ${String(seed.imported.length)} history round(s) from ${history.source}\n`)
  }
  const seeded = seed !== undefined && seed.events.length > 0
  const agentOptions = { provider: selection.provider, model: selection.model }
  const agent = config.sessionId !== undefined
    ? await resumeAgent(ctx, agents, { sessionId: brandString<SessionId>(config.sessionId), agentPreset, cwd, agentOptions, setup })
    : (await agents.create({
      sessionId: brandString<SessionId>(`session-${randomUUID()}`),
      meta: { cwd, ...agentPreset === undefined ? {} : { agentPreset }, ...seeded ? { isSeeded: true } : {} },
      ...seeded && seed !== undefined ? { seed: seed.events, inheritedEventCount: SessionLogOffset(seed.events.length) } : {},
      agentOptions,
      setup,
    })).agent
  await agent.whenIdle()
  const firstSeq = agent.session.seq
  const stopReasoning = streamReasoning(ctx, agent, io.stderr)
  try {
    // Admission runs before the request enters the loop, so its verdict is recorded with the request.
    await intakeGuard.submit(agent, { text: config.task, context: config.context, owner: CLI_OWNER, agent: identity }, new AbortController().signal)
    await agent.whenIdle()
  } finally {
    stopReasoning()
  }
  await sessions.flush(agent.session)
  const reason = summarize(agent.session, firstSeq)
  const parts = a2ui.turnParts(agent.session, firstSeq)
  io.stdout.write(config.result === 'json' ? `${JSON.stringify(tryResultOf(ctx, agent, firstSeq, parts, reason, selection))}\n` : renderTurn(parts) + '\n')
  io.stderr.write(`lyteboat: session ${agent.session.id}\n`)
  if (reason?.kind === 'error') {
    io.stderr.write(`lyteboat: ${reason.error.code}: ${reason.error.message}\n`)
  }
  io.exit(reason?.kind === 'completed' ? 0 : 1)
}

export default class LyteboatTryRunner {
  /** Core services required before the one-shot turn can start. */
  static inject = ['agentDefaultModel', 'agents', 'agentPresets', 'agentCatalog', 'sessions', 'sessionQuery', 'sessionProjections', 'historyImport', 'a2ui', 'intakeGuard']
  static Config: z<LyteboatTryConfig> = z.object({
    task: z.string().required(),
    agent: z.string(),
    history: z.string(),
    sessionId: z.string(),
    context: z.dict(z.any()),
    result: z.union(['text', 'json'] as const).default('text'),
  })

  /**
   * Mount the one-shot runner.
   * @param ctx - plugin context carrying core services and the launcher-provided exit request.
   * @param tryConfig - validated task config.
   */
  constructor(ctx: Context, tryConfig: LyteboatTryConfig) {
    const exit = ctx.get('appExit')
    if (exit === undefined) {
      throw new Error('lyteboat-try: the launcher must provide ctx.appExit before the tree mounts')
    }
    const io: RunIo = { stdout: process.stdout, stderr: process.stderr, exit }
    void run(ctx, tryConfig, io).catch((error: unknown) => { fail(io, error) })
  }
}
