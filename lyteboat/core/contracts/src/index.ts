/**
 * lyteboat's contract extensions over the dsh seams. Types, constants,
 * declaration merging, and the zod schemas of the JSON types declared here; no
 * other runtime behavior: the tool and skill metadata lyteboat plugins consume, the
 * `lyteboat/*` step events (declared by lyteboat's kernel agent loop, re-exported
 * here), the log nodes lyteboat plugins append, the envelopes their facts ride,
 * and the projection keys they publish. Declared here, by declaration merging onto
 * the dsh maps, so that providers and consumers depend on this package and
 * never on each other — the same rule dsh applies to its own seams. A reader
 * that finds a lyteboat envelope failing its schema throws: lyteboat wrote it.
 *
 * Session log vocabulary: dsh's persistence layer refuses to reopen a log
 * that carries an event type outside its compiled catalog unless the event is
 * marked `ignorable`, and a reader skips a marked event. Every lyteboat fact a
 * reader needs therefore rides an envelope dsh already knows — `tool/result.meta`
 * for cards and state deltas, the assistant message `source` for a reply's
 * author, dsh's own skill-invocation message for a routed skill — so every
 * lyteboat session reopens. The one record type of lyteboat's own,
 * `lyteboat/aux-llm-call`, is informational and appended ignorable (the kernel
 * extension `session-append-ignorable`), so a reader that does not know it
 * skips it.
 * @module @lyteboat/contracts
 */

import { z } from 'zod'
import type {} from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection/types'

/** Lossless JSON, the only shape session logs and projections may carry. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

/** The schema of {@link JsonValue}. */
export const lyteboatJsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.string(), z.number(), z.boolean(), z.null(), z.array(lyteboatJsonValueSchema), z.record(z.string(), lyteboatJsonValueSchema),
]))

const lyteboatJsonObjectSchema = z.record(z.string(), lyteboatJsonValueSchema)

/**
 * The kernel's pre-assembly step events (`lyteboat/intake`, `lyteboat/pre-assemble`)
 * and their payloads are declared by lyteboat's agent loop
 * (dsh/core/agent-loop/src/lyteboat/step-hooks.ts, dsh-compat/contract/extensions.yml), which
 * cannot import this package; plugins read them from here.
 * `LYTEBOAT_ASSISTANT_PROVIDER` is the provider of every assistant message lyteboat
 * writes without a model call (intake replies, imported history).
 */
export { LYTEBOAT_ASSISTANT_PROVIDER } from '@deepseek-ai/dsh-agent-loop'
export type { LyteboatIntakeDecision, LyteboatIntakeReply, LyteboatStepPayload } from '@deepseek-ai/dsh-agent-loop'

/** One extension of the kernel contract that this lyteboat build carries, as dsh-compat/contract/extensions.yml registers it. */
export interface LyteboatDistroExtension {
  /** The registry id (`agent-loop-intake`, …). */
  id: string
  /** The kernel package the extension lives in. */
  package: string
  /** `event`, `api`, `api-option`, `service`, or `config`. */
  kind: string
}

/**
 * The `lyteboatDistro` service (@lyteboat/distro): present only on lyteboat, so a plugin
 * that uses a kernel extension declares `inject: ['lyteboatDistro']` and does not
 * load on the official release, where the extension does not exist.
 */
export interface LyteboatDistro {
  /** The dsh release the kernel was imported from. */
  readonly dsh: string
  /** Every kernel extension this build carries. */
  readonly extensions: readonly LyteboatDistroExtension[]
  /** Whether this build carries the extension registered under `id`. */
  has(id: string): boolean
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    lyteboatDistro: LyteboatDistro
  }
}

/**
 * `source.kind` of the user messages imported history writes; consumers treat
 * them as conversation, not as context. It is dsh's producer kind for the
 * plugin `lyteboat-history-import` (`plugin:<name>`), the kind dsh's session
 * format also reads a stored `{ kind: 'plugin', plugin: 'lyteboat-history-import' }` source as.
 */
export const LYTEBOAT_HISTORY_IMPORT_SOURCE = 'plugin:lyteboat-history-import'

/** `source.kind` of the one user message a side model call sends (`@lyteboat/aux-llm`; the call is recorded, the message is not). */
export const LYTEBOAT_AUX_LLM_SOURCE = 'plugin:lyteboat-aux-llm'

/** Where the `lyteboat:state` runtime context (`@lyteboat/tool-policy`) sits among dsh's (sandbox 110, approval 115, delegation 120). */
export const LYTEBOAT_STATE_CONTEXT_ORDER = 130

/** Where the `lyteboat:skills` system prompt section (`@lyteboat/skill-router`, full mode) sits among the sections (before PLAN_POLICY at 500). */
export const LYTEBOAT_SKILLS_SECTION_ORDER = 450

/** When a tool's schema reaches the model: always, or only after a skill (or a plugin) activated it. */
export type LyteboatToolVisibility = 'always' | 'auto'

/** Whether the tools an agent inherits from the host, and no declaration names, reach the model. */
export type LyteboatInheritedToolVisibility = 'visible' | 'hidden'

/** lyteboat-side metadata registered beside a dsh ToolDefinition (the reference AgentTool fields). */
export interface LyteboatToolMeta {
  /** Defaults to `always`. */
  visibility?: LyteboatToolVisibility
  /**
   * Derive a state delta (dot-path keys, deep-merged into the session state
   * projection) from the tool's validated return value. Runs where dsh
   * computes presentation meta, before post-execute listeners.
   */
  stateDelta?: (args: unknown, value: unknown) => JsonValue | undefined
}

/** lyteboat-side skill metadata: the `metadata.lyteboat` object of a SKILL.md frontmatter. */
export interface LyteboatSkillMeta {
  /** Tools the skill needs; activated (made visible) when the skill is routed. */
  requiredTools?: string[]
}

/** The schema of {@link LyteboatSkillMeta}; strict, since a misspelt key in a hand-written frontmatter must not silently mean nothing. */
export const lyteboatSkillMetaSchema: z.ZodType<LyteboatSkillMeta> = z.strictObject({
  requiredTools: z.array(z.string()).exactOptional(),
})

/**
 * When a card is shown: `immediate` as soon as its result arrives; `deferred`
 * where the answer writes its area's marker, or after the answer when it never
 * does; `deferred_discard` where the marker is, and nowhere otherwise.
 */
export type LyteboatCardEmission = 'immediate' | 'deferred' | 'deferred_discard'

/** One rendered A2UI card, as a tool result's `meta.lyteboat.cards` carries it (a type, so it is JSON). */
export type LyteboatResultCard = {
  surfaceId: string
  /** The name an answer places the card with: `[[card:<area>]]`. */
  area: string
  emission: LyteboatCardEmission
  payload: JsonValue
}

const lyteboatResultCardShape = {
  surfaceId: z.string(),
  area: z.string(),
  emission: z.enum(['immediate', 'deferred', 'deferred_discard']),
  payload: lyteboatJsonValueSchema,
}

/** The schema of {@link LyteboatResultCard}. */
export const lyteboatResultCardSchema: z.ZodType<LyteboatResultCard> = z.object(lyteboatResultCardShape)

/** A card the session prepared, with what prepared it: the tool call, or the admission reply's message. */
export type LyteboatCard = LyteboatResultCard & {
  callId: string
}

/** The schema of {@link LyteboatCard}. */
export const lyteboatCardSchema: z.ZodType<LyteboatCard> = z.object({ ...lyteboatResultCardShape, callId: z.string() })

/** A state delta: a JSON object whose top-level keys are dot paths into the `lyteboatState` projection (`assets.total`). */
export type LyteboatStateDelta = { [path: string]: JsonValue }

/** The schema of {@link LyteboatStateDelta}. */
export const lyteboatStateDeltaSchema: z.ZodType<LyteboatStateDelta> = lyteboatJsonObjectSchema

/**
 * What a tool result's presentation meta carries under `lyteboat`
 * (`tool/result.meta.lyteboat`): the cards the call rendered, and the state
 * delta it derived.
 */
export type LyteboatResultMeta = {
  cards?: LyteboatResultCard[]
  stateDelta?: LyteboatStateDelta
}

/** The schema of {@link LyteboatResultMeta}. */
export const lyteboatResultMetaSchema: z.ZodType<LyteboatResultMeta> = z.object({
  cards: z.array(lyteboatResultCardSchema).exactOptional(),
  stateDelta: lyteboatStateDeltaSchema.exactOptional(),
})

/** The `lyteboatState` projection value: tool state accumulated by dot-path deep merge of `tool/result.meta.lyteboat.stateDelta`. */
export type LyteboatStateValue = { [key: string]: JsonValue }

/** The schema of {@link LyteboatStateValue}. */
export const lyteboatStateValueSchema: z.ZodType<LyteboatStateValue> = lyteboatJsonObjectSchema

/** One side model call, as its `lyteboat/aux-llm-call` record keeps it. */
export interface LyteboatAuxLlmCallRecord {
  /** What the call was for: `skill-router`, `intake`, … */
  purpose: string
  route: { provider: string; model: string }
  system: string
  /** The one user message the call sent. */
  prompt: string
  maxTokens: number
  temperature: number
  /** The reasoning effort the call requested; absent: the route's default. */
  reasoningEffort?: string
  /** The model's text; absent when the call failed. */
  output?: string
  /** Why the call has no answer: `timeout`, `max-tokens`, or the error's name, with its message. */
  failure?: { reason: string; message: string }
  durationMs: number
}

/**
 * An admission function's decision on one request, made before the request
 * enters the loop and recorded on the request's human message.
 */
export type LyteboatIntakeVerdict = {
  /** The admission function that decided. */
  by: string
  /** `pass`: the model answers. `reply`: `text` answers without a model request, with `cards` if any. */
  decision: 'pass' | 'reply'
  /** The agent's label for the decision (`out_of_scope`, `unauthorized`, …). */
  verdict?: string
  text?: string
  cards?: LyteboatResultCard[]
}

/** The schema of {@link LyteboatIntakeVerdict}. */
export const lyteboatIntakeVerdictSchema: z.ZodType<LyteboatIntakeVerdict> = z.object({
  by: z.string(),
  decision: z.enum(['pass', 'reply']),
  verdict: z.string().exactOptional(),
  text: z.string().exactOptional(),
  cards: z.array(lyteboatResultCardSchema).exactOptional(),
})

/**
 * Who a request comes from: `user`, an end user the caller names (`/chat`'s
 * `user_id`); `operator`, a person at a lyteboat surface (the web pages,
 * the command line); `system`, lyteboat itself (an eval run). Only a `user`
 * owner can continue a session over `/chat`. Not dsh's `source.kind: 'user'`,
 * which says a human message came from the conversation's human side, whoever
 * sent it.
 */
export type LyteboatRequestOwner = {
  kind: 'user' | 'operator' | 'system'
  id: string
}

/** The schema of {@link LyteboatRequestOwner}. */
export const lyteboatRequestOwnerSchema: z.ZodType<LyteboatRequestOwner> = z.object({
  kind: z.enum(['user', 'operator', 'system']),
  id: z.string().min(1),
})

/**
 * The model an agent declares in its `agent.yml`: the provider route, the
 * provider's model id, and the reasoning effort when the agent fixes one. A
 * business mode that enforces the declaration compares all three exactly.
 */
export type LyteboatAgentModel = {
  provider: string
  model: string
  reasoningEffort?: string
}

/** The schema of {@link LyteboatAgentModel}. */
export const lyteboatAgentModelSchema: z.ZodType<LyteboatAgentModel> = z.strictObject({
  provider: z.string().min(1),
  model: z.string().min(1),
  reasoningEffort: z.string().min(1).exactOptional(),
})

/**
 * An agent's manifest, `<agent>/agent.yml`: display fields (`name`,
 * `description`, `order`), the version its author promises (`1.2.3` or
 * `1.2.3-rc.1`), and the model it is evaluated on. Every field is optional; a
 * release needs `version` and `model`.
 */
export type LyteboatAgentManifest = {
  name?: string
  description?: string
  order?: number
  version?: string
  model?: LyteboatAgentModel
}

// YAML reads an unquoted 1.0 as a number: say how to write it.
const lyteboatAgentVersionSchema = z.string({ error: 'must be a string such as 1.2.3; quote it in YAML (version: "1.0.0")' }).regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u, 'must look like 1.2.3 or 1.2.3-rc.1')

const lyteboatAgentDigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u, 'must be sha256: and 64 lowercase hex digits')

/** The schema of {@link LyteboatAgentManifest}; an unknown key fails. */
export const lyteboatAgentManifestSchema: z.ZodType<LyteboatAgentManifest> = z.strictObject({
  name: z.string().exactOptional(),
  description: z.string().exactOptional(),
  order: z.number().finite().exactOptional(),
  version: lyteboatAgentVersionSchema.exactOptional(),
  model: lyteboatAgentModelSchema.exactOptional(),
})

/**
 * Which agent answered: its id, the version its manifest declares, and the
 * digest of its directory (`sha256:` and 64 lowercase hex digits, computed by
 * `@lyteboat/agent-catalog`). A request, an eval run, and a release lock carry
 * the same shape.
 */
export type LyteboatAgentIdentity = {
  id: string
  version?: string
  digest: string
}

/** The schema of {@link LyteboatAgentIdentity}. */
export const lyteboatAgentIdentitySchema: z.ZodType<LyteboatAgentIdentity> = z.strictObject({
  id: z.string().min(1),
  version: z.string().min(1).exactOptional(),
  digest: lyteboatAgentDigestSchema,
})

/**
 * What an eval run was and how it went, as its `run.json`: the agent it ran
 * (identity), the model its recorded requests used (a real run whose loop sent
 * requests; a replay records none), the mode, the run a replay played back,
 * and the case, turn, and check totals.
 */
export type LyteboatEvalRunRecord = {
  agent: LyteboatAgentIdentity
  model?: LyteboatAgentModel
  mode: 'real' | 'replay'
  from?: string
  cases: { id: string; pass: boolean }[]
  turns: { total: number; passed: number }
  checks: { total: number; passed: number }
  startedAt: string
  durationMs: number
}

const lyteboatEvalTotalsSchema = z.object({ total: z.number(), passed: z.number() })

/** An eval run's id, its directory's name under `$LYTEBOAT_HOME/evals`: one path segment of letters, digits, dots, dashes, and underscores. */
export const LYTEBOAT_EVAL_RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u

/** An eval case's id in an agent's `evals/cases.yml`: kebab-case. */
export const LYTEBOAT_EVAL_CASE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u

/** The schema of {@link LyteboatEvalRunRecord}: a `run.json` is a file, read at a boundary. */
export const lyteboatEvalRunRecordSchema: z.ZodType<LyteboatEvalRunRecord> = z.object({
  agent: lyteboatAgentIdentitySchema,
  model: lyteboatAgentModelSchema.exactOptional(),
  mode: z.enum(['real', 'replay']),
  from: z.string().exactOptional(),
  cases: z.array(z.object({ id: z.string(), pass: z.boolean() })),
  turns: lyteboatEvalTotalsSchema,
  checks: lyteboatEvalTotalsSchema,
  startedAt: z.string(),
  durationMs: z.number(),
})

/** The file name of an agent's release lock, beside its manifest (see {@link LyteboatAgentRelease}). */
export const LYTEBOAT_AGENT_RELEASE_FILE = 'agent.release.json'

/**
 * An agent's release lock, `<agent>/agent.release.json`, written by `lyteboat
 * release` once the agent passed its release gate and read by `lyteboat serve
 * --release`: the agent released (id, version, digest), the model it was
 * evaluated on, the dsh release of the kernel that evaluated it, the per-file
 * content hashes behind the digest (POSIX relative path → sha256), and the
 * baseline that was replayed (its start, its case, turn, and check totals,
 * and the sha256 of its `results.jsonl`).
 */
export type LyteboatAgentRelease = {
  agent: { id: string; version: string; digest: string }
  model: LyteboatAgentModel
  dshBase: string
  files: { [path: string]: string }
  baseline: { startedAt: string; cases: number; turns: number; checks: number; results: string }
}

/** The schema of {@link LyteboatAgentRelease}: a lock is a file, read at a boundary; an unknown key fails. */
export const lyteboatAgentReleaseSchema: z.ZodType<LyteboatAgentRelease> = z.strictObject({
  agent: z.strictObject({ id: z.string().min(1), version: lyteboatAgentVersionSchema, digest: lyteboatAgentDigestSchema }),
  model: lyteboatAgentModelSchema,
  dshBase: z.string().min(1),
  files: z.record(z.string().min(1), z.string().regex(/^[0-9a-f]{64}$/u, 'must be 64 lowercase hex digits')),
  baseline: z.strictObject({
    startedAt: z.string(),
    cases: z.number().int().nonnegative(),
    turns: z.number().int().nonnegative(),
    checks: z.number().int().nonnegative(),
    results: lyteboatAgentDigestSchema,
  }),
})

/**
 * The request a human message answers to, carried on its `source` beside
 * `kind: 'user'`, so every dsh consumer still reads the message as human
 * input. `@lyteboat/request-context` reads it back.
 */
export type LyteboatRequest = {
  /** The caller's id for the request, when it gave one. */
  requestId?: string
  /** Who sent the request; a session's owner is its first request's. */
  owner?: LyteboatRequestOwner
  /** The caller's trace id for the request, so its logs and the session's can be joined. */
  traceId?: string
  /** The agent the request went to, as the caller's agent catalog knew it when the request was sent. */
  agent?: LyteboatAgentIdentity
  /** The request context as the caller passed it; absent keeps the session's earlier context. */
  context?: { [key: string]: JsonValue }
  intake?: LyteboatIntakeVerdict
}

/** The schema of {@link LyteboatRequest}, the envelope on a human message's `source.lyteboatRequest`. */
export const lyteboatRequestSchema: z.ZodType<LyteboatRequest> = z.object({
  requestId: z.string().exactOptional(),
  owner: lyteboatRequestOwnerSchema.exactOptional(),
  traceId: z.string().exactOptional(),
  agent: lyteboatAgentIdentitySchema.exactOptional(),
  context: lyteboatJsonObjectSchema.exactOptional(),
  intake: lyteboatIntakeVerdictSchema.exactOptional(),
})

/** The `lyteboatRequest` fold state: the session's request context and the latest request's verdict. */
export type LyteboatRequestState = {
  /** Human messages that carried a request. */
  requests: number
  /** The latest context a request carried; empty before any. */
  context: { [key: string]: JsonValue }
  /** The latest request's verdict, when an admission function ran on it. */
  intake: LyteboatIntakeVerdict | null
  /** The first owner a request named; null before any did. */
  owner: LyteboatRequestOwner | null
}

/** The schema of {@link LyteboatRequestState}. */
export const lyteboatRequestStateSchema: z.ZodType<LyteboatRequestState> = z.object({
  requests: z.number(),
  context: lyteboatJsonObjectSchema,
  intake: lyteboatIntakeVerdictSchema.nullable(),
  owner: lyteboatRequestOwnerSchema.nullable(),
})

/**
 * How one turn ended, as a caller that submitted a request reads it:
 * `completed` (the model answered), `rejected` (the admission answered in the
 * loop, without a model request), `tool_stopped` (a tool was blocked and the
 * turn stopped), `stopped_by_limit` (a step reached its output-token ceiling),
 * `aborted` (cancelled), `errored` (failed).
 */
export type LyteboatTurnOutcome = 'completed' | 'rejected' | 'tool_stopped' | 'stopped_by_limit' | 'aborted' | 'errored'

/**
 * A turn's outcome by the kind of its `turn/end` reason. A kind not listed is
 * `errored`: `error`; `interrupted` and `forked`, which close a turn after the
 * fact; and any reason a plugin merges into dsh's open reason map. A
 * `completed` turn whose answer came from the admission in the loop (an
 * assistant message with provider {@link LYTEBOAT_ASSISTANT_PROVIDER}) is
 * `rejected`.
 */
export const LYTEBOAT_TURN_OUTCOME_OF_REASON: { readonly [reason: string]: LyteboatTurnOutcome } = {
  completed: 'completed',
  blocked: 'tool_stopped',
  'max-tokens': 'stopped_by_limit',
  aborted: 'aborted',
}

/** The turn outcomes, as a list. */
export const LYTEBOAT_TURN_OUTCOMES = ['completed', 'rejected', 'tool_stopped', 'stopped_by_limit', 'aborted', 'errored'] as const satisfies readonly LyteboatTurnOutcome[]

/**
 * One turn a service ran, as its run-metrics recorder appends it to
 * `$LYTEBOAT_HOME/run-metrics/<YYYY-MM-DD>.jsonl` (the UTC day the turn
 * started), one line each, after the turn's `turn/end`. It carries counts and
 * timings, no message text: the Studio's dashboard reads it.
 */
export type LyteboatRunMetric = {
  agentId: string
  sessionId: string
  turn: number
  owner?: LyteboatRequestOwner
  /** When the turn started (epoch ms). */
  startedAt: number
  durationMs: number
  /** From the start to the first answer text or immediate card; the duration when there was neither. */
  firstContentMs: number
  steps: number
  modelRequests: number
  auxCalls: number
  /** The tool calls, dsh's `skill` tool (a skill load) left out. */
  tools: { name: string; durationMs?: number; isError: boolean; errorCode?: string }[]
  /** Every skill active at some point of the turn, in order, once each. */
  activatedSkills: string[]
  /** The skill active when the turn ended. */
  activeSkill?: string
  outcome: LyteboatTurnOutcome
  /** The failure code of an `errored` turn. */
  errorCode?: string
}

/** The schema of {@link LyteboatRunMetric}. */
export const lyteboatRunMetricSchema: z.ZodType<LyteboatRunMetric> = z.object({
  agentId: z.string(),
  sessionId: z.string(),
  turn: z.number(),
  owner: lyteboatRequestOwnerSchema.exactOptional(),
  startedAt: z.number(),
  durationMs: z.number(),
  firstContentMs: z.number(),
  steps: z.number(),
  modelRequests: z.number(),
  auxCalls: z.number(),
  tools: z.array(z.object({ name: z.string(), durationMs: z.number().exactOptional(), isError: z.boolean(), errorCode: z.string().exactOptional() })),
  activatedSkills: z.array(z.string()),
  activeSkill: z.string().exactOptional(),
  outcome: z.enum(LYTEBOAT_TURN_OUTCOMES),
  errorCode: z.string().exactOptional(),
})

/**
 * The turns one service process is running, as its recorder keeps them in
 * `$LYTEBOAT_HOME/run-metrics/running/<host>-<pid>.json`: rewritten at each
 * turn's start and end and every ten seconds. A reader treats a file whose
 * heartbeat is older than 30 seconds as a process that is gone.
 */
export type LyteboatRunHeartbeat = {
  host: string
  pid: number
  heartbeatAt: number
  turns: { agentId: string; sessionId: string; turn: number; startedAt: number }[]
}

/** The schema of {@link LyteboatRunHeartbeat}. */
export const lyteboatRunHeartbeatSchema: z.ZodType<LyteboatRunHeartbeat> = z.object({
  host: z.string(),
  pid: z.number(),
  heartbeatAt: z.number(),
  turns: z.array(z.object({ agentId: z.string(), sessionId: z.string(), turn: z.number(), startedAt: z.number() })),
})

/** The `lyteboatActiveSkill` fold state. */
export interface LyteboatActiveSkillState {
  /** The skill in force; null before any skill is active. */
  active: string | null
  /** `skill` tool calls still awaiting their result: the skill each loads, by call id. */
  loading: { [callId: string]: string }
}

/** The schema of {@link LyteboatActiveSkillState}. */
export const lyteboatActiveSkillStateSchema: z.ZodType<LyteboatActiveSkillState> = z.object({
  active: z.string().nullable(),
  loading: z.record(z.string(), z.string()),
})

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Imported history rounds, written by `@lyteboat/history-import` into a session seed. */
    'plugin:lyteboat-history-import': { kind: typeof LYTEBOAT_HISTORY_IMPORT_SOURCE }
    /** A side model call's prompt, owned by `@lyteboat/aux-llm`. */
    'plugin:lyteboat-aux-llm': { kind: typeof LYTEBOAT_AUX_LLM_SOURCE }
    /** A human message that carries its request (context, verdict), written by the caller through `@lyteboat/request-context`. */
    'lyteboat-request': { kind: 'user'; lyteboatRequest: LyteboatRequest }
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * One side model call a plugin made for the agent, appended ignorable by
     * `@lyteboat/aux-llm`: no reader needs it to rebuild the session.
     */
    'lyteboat/aux-llm-call': LyteboatAuxLlmCallRecord
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Session tool state (host fold of `tool/result.meta.lyteboat.stateDelta`), owned by `@lyteboat/tool-policy`. */
    lyteboatState: LyteboatStateValue
    /** The skill active for the session, folded from skill-invocation messages and `skill` tool calls; owned by `@lyteboat/skill-router`. */
    lyteboatActiveSkill: LyteboatActiveSkillState
    /** Cards from `tool/result.meta.lyteboat.cards` and admission replies, in log order; a `surfaceUpdate` replaces its surface. Owned by `@lyteboat/a2ui`. */
    lyteboatCards: LyteboatCard[]
    /** The request context and the latest verdict, folded from human messages that carry a request. Owned by `@lyteboat/request-context`. */
    lyteboatRequest: LyteboatRequestState
  }
  interface SessionProjectionMap {
    /** Session tool state as the client sees it: the fold state itself. */
    lyteboatState: LyteboatStateValue
    /** The active skill as the client sees it; null before any skill is active. */
    lyteboatActiveSkill: string | null
    /** Every card the session prepared, as the client sees it; what a turn shows is `ctx.a2ui.turnParts`. */
    lyteboatCards: LyteboatCard[]
    /** The request state as the client sees it. */
    lyteboatRequest: LyteboatRequestState
  }
}
