/**
 * The Studio API's wire contract: what `/api/studio/*` takes and answers, for
 * the workshop's host face (`@lyteboat/studio-api`) and its browser face
 * (`@lyteboat/studio-web`) alike. Types, constants, and the zod schemas of the
 * requests a host validates; no other runtime behavior. A request body that
 * fails its schema, an unknown key included, is refused as `invalid_request`.
 * @module @lyteboat/contracts/studio
 */

import { z } from 'zod'
import type { LyteboatSkillFinding } from './cli.ts'
import { LYTEBOAT_EVAL_CASE_ID_PATTERN } from './index.ts'
import type { JsonValue, LyteboatAgentIdentity, LyteboatAgentModel, LyteboatRequest, LyteboatRequestOwner, LyteboatTurnOutcome } from './index.ts'

/** The Studio roles, from the most to the least capable. */
export const STUDIO_ROLES = ['admin', 'editor', 'viewer'] as const

/** A Studio role: admin (users, hot-fixes), editor (eval runs), viewer (reads). */
export type StudioRole = typeof STUDIO_ROLES[number]

/** The schema of {@link StudioRole}. */
export const studioRoleSchema: z.ZodType<StudioRole> = z.enum(STUDIO_ROLES)

/** Who a request speaks for. */
export type StudioPrincipal = {
  userId: string
  displayName: string
  role: StudioRole
}

/** How a Studio signs people in: its own accounts, or the identity an authorizing gateway puts on each request. */
export type StudioAuthMode = 'internal' | 'gateway'

/** `GET auth/config`. */
export type StudioAuthConfigAnswer = {
  mode: StudioAuthMode
  /** Whether the login page asks for a password (internal mode). */
  loginRequired: boolean
  /** Whether a request without a token reads as an anonymous viewer. */
  anonymousViewer: boolean
}

/** `POST auth/login`. */
export type StudioLoginRequest = {
  username: string
  password: string
}

/** The schema of {@link StudioLoginRequest}. */
export const studioLoginRequestSchema: z.ZodType<StudioLoginRequest> = z.strictObject({
  username: z.string().min(1).max(200),
  password: z.string().min(1).max(1000),
})

/** `POST auth/login`, and `GET auth/session` in gateway mode (without a token). */
export type StudioLoginAnswer = StudioPrincipal & {
  /** The bearer token, absent in gateway mode. */
  token?: string
  /** When the token expires (epoch ms). */
  expiresAt?: number
}

/** One user's role grant, as the Users page lists it. */
export type StudioGrant = {
  userId: string
  role: StudioRole
  createdAt: number
  updatedAt: number
  createdBy: string
  updatedBy: string
}

/** `GET users`: one page of grants, filtered. */
export type StudioUsersAnswer = {
  users: StudioGrant[]
  total: number
  /** Admins among all grants, filter aside: the last one cannot lose the role. */
  adminCount: number
}

/** `POST users`: grant or change a role. */
export type StudioGrantRequest = {
  userId: string
  role: StudioRole
}

/** The schema of {@link StudioGrantRequest}. */
export const studioGrantRequestSchema: z.ZodType<StudioGrantRequest> = z.strictObject({
  userId: z.string().min(1).max(200),
  role: studioRoleSchema,
})

/** An environment variable as the System page shows it: secrets masked. */
export type StudioEnvEntry = {
  name: string
  value: string
}

/** `GET system/properties`. */
export type StudioSystemAnswer = {
  os: { [key: string]: string | number }
  runtime: { [key: string]: string | number }
  lyteboat: {
    /** The launcher's version; absent when no launcher booted this Studio (an embedding host). */
    version?: string
    dshBase: string
    extensions: string[]
    home: string
    agentRoots: string[]
  }
  properties: { [key: string]: string | number | string[] }
  env: StudioEnvEntry[]
}

/** `GET config/trace-link`: the template an external trace id fills (`{trace_id}`), when one is configured. */
export type StudioTraceLinkAnswer = {
  template?: string
}

/** One agent as the radar lists it. */
export type StudioAgent = {
  id: string
  name?: string
  description?: string
  order?: number
  version?: string
  digest: string
  /** The release lock beside the agent, when there is one. */
  release?: { version: string; digest: string }
  /** Whether the agent's directory differs from its release lock. */
  deviates: boolean
  /** Why the release lock beside the agent could not be read; the agent is listed without one. */
  releaseProblem?: string
}

/** One agent the catalog could not serve. */
export type StudioAgentFailure = {
  id: string
  reason: string
}

/** `GET agents`, `POST agents/reload`. */
export type StudioAgentsAnswer = {
  agents: StudioAgent[]
  failures: StudioAgentFailure[]
}

/** How an agent's tool policy declares a tool: `always` or `auto` by a declaration, `inherited` by none. */
export type StudioToolDeclaration = 'always' | 'auto' | 'inherited'

/**
 * Whether a tool reaches the model when an agent starts: `always`; `activated`,
 * once a skill that requires it is active or the agent's code activates it;
 * `hidden`, never (an inherited tool the policy hides).
 */
export type StudioToolReach = 'always' | 'activated' | 'hidden'

/** One tool an agent can reach, as the Tools page shows it. */
export type StudioTool = {
  name: string
  description: string
  /** The parameters' JSON Schema, as the model receives it. */
  parameters: { [key: string]: unknown }
  declared: StudioToolDeclaration
  reach: StudioToolReach
  /** The skills whose metadata requires the tool. */
  requiredBy: string[]
}

/** `GET agents/:id/tools`. */
export type StudioToolsAnswer = {
  tools: StudioTool[]
}

/** How an agent picks its skills (its skill router's settings). */
export type StudioSkillRouting = {
  mode: 'off' | 'full' | 'dynamic'
  /** The router's own model, when it does not use the agent's. */
  provider?: string
  model?: string
}

/** One skill of an agent, as the Skills list shows it. */
export type StudioSkillSummary = {
  name: string
  description: string
  whenToUse?: string
  modelInvocable: boolean
  userInvocable: boolean
  /** The tools its lyteboat metadata requires. */
  requiredTools: string[]
  /** Its SKILL.md relative to the agent directory; absent for a skill registered in code or outside the directory. */
  path?: string
  /** When its SKILL.md last changed (epoch ms). */
  updatedAt?: number
  /** Why its lyteboat metadata cannot be read; the router would refuse it. */
  metadataProblem?: string
}

/** `GET agents/:id/skills`. */
export type StudioSkillsAnswer = {
  skills: StudioSkillSummary[]
  routing: StudioSkillRouting
}

/** `GET agents/:id/skills/:name`: a skill with its body and, when it has one, its file. */
export type StudioSkillDetail = StudioSkillSummary & {
  /** The body the model loads. */
  content: string
  /** The SKILL.md as stored, frontmatter included; what a hot-fix replaces. */
  file?: string
  /** The sha256 (hex) of `file`: a hot-fix sends it as `If-Match`. */
  sha256?: string
}

/** `PUT agents/:id/skills/:name` (admins): the SKILL.md's new text, frontmatter included. */
export type StudioSkillUpdateRequest = {
  file: string
}

/** The schema of {@link StudioSkillUpdateRequest}. */
export const studioSkillUpdateRequestSchema: z.ZodType<StudioSkillUpdateRequest> = z.strictObject({
  file: z.string().min(1).max(512 * 1024),
})

/** The answer to a hot-fix: the skill as stored now, and the agent (its digest, whether it deviates from its release). */
export type StudioSkillUpdateAnswer = {
  skill: StudioSkillDetail
  agent: StudioAgent
}

/** `POST agents/:id/skills/:name/diagnostics`: the skill's checks, and what the page words them with. */
export type StudioSkillDiagnosticsAnswer = {
  skill: string
  generatedAt: number
  requiredTools: string[]
  routing: StudioSkillRouting['mode']
  findings: LyteboatSkillFinding[]
}

/**
 * One stored session of an agent, as the Sessions list shows it. The counts
 * leave out imported history: `errorCount`, tool results that failed and
 * turns that ended `errored`; `rejectedCount`, turns the admission answered;
 * `abortedCount`, turns cancelled; `slowCount`, model answers and tool calls
 * that took 10 seconds or more.
 */
export type StudioSessionSummary = {
  sessionId: string
  /** The owner the session's first request named. */
  owner?: LyteboatRequestOwner
  createdAt: number
  /** When its last event was written (epoch ms). */
  updatedAt: number
  /** Human messages and assistant answers. */
  messageCount: number
  turnCount: number
  /** The first and the latest human message, cut to 80 characters. */
  firstMessage?: string
  lastUserMessage?: string
  errorCount: number
  rejectedCount: number
  abortedCount: number
  slowCount: number
  /** The last turn has no `turn/end`: it is running, or its process exited. */
  openTurn: boolean
  /** The session starts with imported history. */
  seeded: boolean
}

/** `GET agents/:id/sessions`: newest first, a page of the sessions in the window. */
export type StudioSessionsAnswer = {
  sessions: StudioSessionSummary[]
  /** Sessions in the window and owner filter, all pages. */
  total: number
  hasMore: boolean
}

/** What a search matched: the session id, a human message, or a request's trace id. */
export type StudioSessionMatchKind = 'session' | 'question' | 'trace'

/** One session a search found, with where it matched. */
export type StudioSessionMatch = StudioSessionSummary & {
  matchKind: StudioSessionMatchKind
  matchedSnippet: string
}

/** `GET agents/:id/sessions/find`: at most 500 newest sessions of the window are searched. */
export type StudioSessionFindAnswer = {
  sessions: StudioSessionMatch[]
  hasMore: boolean
}

/** One entry of a session's timeline, folded from its log in log order. */
export type StudioTimelineItem =
  | { kind: 'user'; seq: number; turn: number; time: number; text: string; request?: LyteboatRequest; imported: boolean }
  | {
    kind: 'assistant'; seq: number; turn: number; time: number; text: string
    reasoning?: string
    usage?: { inputTokens: number; outputTokens: number; totalTokens?: number; cacheReadTokens?: number; reasoningTokens?: number }
    /** `provider/model`. */
    model?: string
    /** From the step's start to the answer, and to its first streamed chunk. */
    llmMs?: number
    firstTokenMs?: number
    /** The admission answered, not a model. */
    answeredByAdmission: boolean
    imported: boolean
  }
  | {
    kind: 'tool'; seq: number; turn: number; time: number; callId: string; name: string
    /** The arguments as the model wrote them, parsed when they are JSON. */
    arguments: JsonValue
    /** The model-facing result text; absent while the call has no result. */
    result?: string
    isError: boolean
    durationMs?: number
    /** The areas of the cards the call rendered. */
    cards: string[]
    stateDelta?: { [path: string]: JsonValue }
    /** A later surface replacement shortened the result the model sees. */
    pruned: boolean
  }
  | { kind: 'skill'; seq: number; turn: number; time: number; skill: string }
  | { kind: 'aux'; seq: number; turn: number; time: number; purpose: string; durationMs: number; failure?: string }
  | { kind: 'compaction'; seq: number; turn: number; time: number; replaced: number }
  | { kind: 'turn-end'; seq: number; turn: number; time: number; outcome: LyteboatTurnOutcome }

/** `GET agents/:id/sessions/:sid`. */
export type StudioSessionDetail = {
  summary: StudioSessionSummary
  items: StudioTimelineItem[]
}

/** `GET agents/:id/sessions/:sid/raw`: the stored header and events, as stored. */
export type StudioSessionRaw = {
  header: JsonValue
  inheritedEventCount: number
  events: JsonValue[]
}

/**
 * The health of a set of turns, as the Dashboard's performance view shows it:
 * requests (turns), how they ended, first-content and total durations
 * (nearest-rank percentiles), steps, tool calls, skills, and users (distinct
 * owners; the peak is how many had a turn running at once).
 */
export type StudioHealthAggregate = {
  requestCount: number
  /** Completed or tool-stopped turns over all. */
  completionRate: number
  /** Errored turns, contention left out. */
  technicalFailureCount: number
  /** Turns stopped by the output limit. */
  incompleteCount: number
  /** Aborted turns and turns the admission answered. */
  controlledExitCount: number
  /** Turns refused because their session was busy. */
  contentionCount: number
  firstContentP50Ms: number | null
  firstContentP95Ms: number | null
  durationP50Ms: number | null
  durationP95Ms: number | null
  averageDurationMs: number | null
  /** Steps per turn (the original Studio's turns per run). */
  averageTurns: number
  turnsP95: number | null
  averageTurnDurationMs: number | null
  toolCallCount: number
  toolErrorCount: number
  averageToolDurationMs: number | null
  skillTriggerCount: number
  activeUsers: number
  peakConcurrentUsers: number
}

/** One time bucket of a health window. */
export type StudioHealthSeriesPoint = StudioHealthAggregate & {
  bucketIndex: number
  /** The bucket's start (epoch ms). */
  startedAt: number
}

/** A tool by calls, with its mean duration. */
export type StudioToolRanking = { name: string; count: number; averageDurationMs: number | null }

/** A skill by the turns it was active in, with their mean steps. */
export type StudioSkillRanking = { skillId: string; count: number; averageTurns: number }

/** The health of a time window: its summary, its buckets, and the top six tools and skills. */
export type StudioHealthWindow = {
  startedAt: number
  endedAt: number
  bucketMinutes: number
  summary: StudioHealthAggregate
  series: StudioHealthSeriesPoint[]
  toolRankings: StudioToolRanking[]
  skillRankings: StudioSkillRanking[]
}

/** `GET dashboard/health?from=&to=[&agent=][&bucket=][&compareFrom=&compareTo=]`. */
export type StudioDashboardHealth = {
  agentIds: string[]
  current: StudioHealthWindow
  /** The window to compare with, bucketed alike; overlay by bucket index. */
  comparison?: StudioHealthWindow
}

/** One agent's turns running now. */
export type StudioRunningAgent = { agentId: string; agentLabel: string; running: number }

/** `GET dashboard/running`: the turns serve processes are running, from their heartbeats. */
export type StudioDashboardRunning = {
  total: number
  agents: StudioRunningAgent[]
}

/** A month's cumulative count. */
export type StudioTrendPoint = { label: string; shortLabel: string; value: number }

/** One bar of a distribution. */
export type StudioDistributionItem = { label: string; value: number; hint?: string }

/** One figure of a section. */
export type StudioInsightStat = { label: string; value: string; hint?: string }

/** One entry of the activity feed. */
export type StudioActivityItem = {
  time: number
  kind: 'skill' | 'session' | 'eval'
  agentId: string
  agentLabel: string
  text: string
  status: 'ok' | 'warn'
}

/** `GET dashboard/summary`: the Dashboard's static view. */
export type StudioDashboardSummary = {
  totalAgents: number
  /** Distinct owners of the end users' sessions. */
  totalUsers: number
  totalSkills: number
  /** Tools that reach the model, always or once activated. */
  totalTools: number
  totalSessions: number
  /** Six months, cumulative: users by their first session, skills by their files, sessions by their last update. */
  trends: { users: StudioTrendPoint[]; skills: StudioTrendPoint[]; sessions: StudioTrendPoint[] }
  skills: { stats: StudioInsightStat[]; agents: StudioDistributionItem[]; requiredTools: StudioDistributionItem[] }
  sessions: { stats: StudioInsightStat[]; agents: StudioDistributionItem[]; messageBands: StudioDistributionItem[] }
  activity: StudioActivityItem[]
  generatedAt: number
}

/** What one eval turn must show, as the agent's case file says it; an absent check is not made. */
export type StudioEvalExpect = {
  skill?: string | null
  tools?: { called?: string[]; not_called?: string[] }
  cards?: { areas?: string[]; count?: number }
  outcome?: LyteboatTurnOutcome
  text?: { includes?: string[]; excludes?: string[]; matches?: string }
  model_requests?: { min?: number; max?: number }
}

/** One case of an agent's case file: a new session and its turns. */
export type StudioEvalCase = {
  id: string
  context?: { [key: string]: JsonValue }
  turns: { message: string; context?: { [key: string]: JsonValue }; expect: StudioEvalExpect }[]
}

/** One case file under the agent's `evals/`: its cases, or why it does not load. */
export type StudioEvalCaseFile = {
  /** Relative to the agent directory, POSIX: `evals/finance.yml`. */
  file: string
  cases: StudioEvalCase[]
  error?: string
}

/** `GET agents/<id>/evals/cases`: the agent's case files in name order, read only. */
export type StudioEvalCasesAnswer = {
  files: StudioEvalCaseFile[]
}

/**
 * An eval run's state: a run the Studio started carries its job's state
 * (`running`, then `passed`, `failed`, `error`, `stopped`, or `interrupted`
 * when the Studio restarted while it ran); a run found only on disk is
 * `passed` or `failed` by its cases, or `incomplete` when it has no
 * `run.json` (a run that stopped or broke before writing it).
 */
export type StudioEvalRunStatus = 'running' | 'passed' | 'failed' | 'error' | 'stopped' | 'interrupted' | 'incomplete'

/** One eval run: the run directory's `run.json`, and the Studio job that started it, if one did. */
export type StudioEvalRun = {
  /** The run directory's name under `$LYTEBOAT_HOME/evals`. */
  runId: string
  agentId: string
  status: StudioEvalRunStatus
  mode: 'real' | 'replay'
  /** The run a replay played back, by id. */
  from?: string
  /** The cases asked for; absent: every case. */
  caseIds?: string[]
  /** Epoch ms. */
  startedAt: number
  durationMs?: number
  /** The agent that ran, as `run.json` records it. */
  agent?: LyteboatAgentIdentity
  model?: LyteboatAgentModel
  /** `done` counts the cases finished so far while the run is running. */
  cases: { total?: number; passed: number; done: number }
  turns?: { total: number; passed: number }
  checks?: { total: number; passed: number }
  /** The user who started it from the Studio. */
  startedBy?: string
  /** Why the run broke (`error`), from the eval process's last error line. */
  error?: string
}

/** `GET evals/runs?agent=<id>`: runs newest first. */
export type StudioEvalRunsAnswer = {
  runs: StudioEvalRun[]
}

/** One expectation's check and its result. */
export type StudioEvalCheck = {
  check: string
  expected: JsonValue
  actual: JsonValue
  pass: boolean
}

/** One turn of an eval case: what it showed and each check. */
export type StudioEvalTurnResult = {
  turn: number
  message: string
  observed: { skill: string | null; tools: string[]; cards: string[]; outcome: LyteboatTurnOutcome; text: string; modelRequests: number }
  checks: StudioEvalCheck[]
  pass: boolean
}

/** One case of a run, its turns in order. */
export type StudioEvalCaseResult = {
  caseId: string
  pass: boolean
  turns: StudioEvalTurnResult[]
}

/** `GET evals/runs/<id>`: the run and its results (none until the run is written). */
export type StudioEvalRunDetail = {
  run: StudioEvalRun
  cases: StudioEvalCaseResult[]
}

/** How a case moved from run A to run B. */
export type StudioEvalCompareStatus = 'improved' | 'regressed' | 'unchanged_pass' | 'unchanged_fail' | 'only_a' | 'only_b'

/** One case compared across two runs. */
export type StudioEvalCompareCase = {
  caseId: string
  /** The case's first message. */
  message: string
  turnCount: number
  aPass: boolean | null
  bPass: boolean | null
  aPassedTurns: number
  bPassedTurns: number
  /** The first turn (1-based) whose result differs; 0 when none does or one side did not run the case. */
  divergedAtTurn: number
  status: StudioEvalCompareStatus
  aFailingChecks: string[]
  bFailingChecks: string[]
}

/** `GET evals/compare?a=<run>&b=<run>`: A is the baseline, B the run compared with it. */
export type StudioEvalCompareAnswer = {
  a: StudioEvalRun
  b: StudioEvalRun
  cases: StudioEvalCompareCase[]
  /** Every check whose result differs, in B's order. */
  changes: { case: string; turn: number; check: string; before: 'pass' | 'fail' | 'absent'; after: 'pass' | 'fail' | 'absent' }[]
  breakdown: { improved: number; regressed: number; unchangedPass: number; unchangedFail: number; onlyA: number; onlyB: number }
}

/** `POST evals/runs` (editor and above): run an agent's cases in a new eval process. */
export type StudioEvalRunRequest = {
  agentId: string
  mode: 'real' | 'replay'
  /** The run a replay plays back, by id; required for a replay. */
  from?: string
  /** Only these cases; absent: every case. */
  caseIds?: string[]
}

/** `DELETE evals/runs/<id>` (editor and above): the run directory removed. */
export type StudioEvalRunDeleted = {
  runId: string
}

/** The schema of {@link StudioEvalRunRequest}. */
export const studioEvalRunRequestSchema: z.ZodType<StudioEvalRunRequest> = z.strictObject({
  agentId: z.string().min(1),
  mode: z.enum(['real', 'replay']),
  from: z.string().min(1).exactOptional(),
  caseIds: z.array(z.string().regex(LYTEBOAT_EVAL_CASE_ID_PATTERN)).min(1).exactOptional(),
})

/** Why a Studio request was refused. */
export type StudioErrorCode =
  | 'invalid_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'precondition_failed'
  | 'too_many_requests'
  | 'payload_too_large'
  | 'misdirected'
  | 'internal'

/** The body of every refused Studio request. */
export type StudioErrorAnswer = {
  error: { code: StudioErrorCode; message: string }
}
