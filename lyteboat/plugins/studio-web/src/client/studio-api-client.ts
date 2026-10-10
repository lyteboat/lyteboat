/**
 * The pages' client of `/api/studio`: one method per endpoint the pages
 * call, typed by `@lyteboat/contracts/studio` (types only, so no schema code
 * reaches the browser). The bearer token is the one the auth context holds; a
 * 401 on anything but a login tells the auth context the sign-in is gone.
 * @module @lyteboat/studio-web/client/studio-api-client
 */

import type {
  StudioAgentsAnswer,
  StudioAuthConfigAnswer,
  StudioChatRequest,
  StudioDashboardHealth,
  StudioDashboardRunning,
  StudioDashboardSummary,
  StudioErrorAnswer,
  StudioErrorCode,
  StudioEvalCasesAnswer,
  StudioEvalCompareAnswer,
  StudioEvalRun,
  StudioEvalRunDeleted,
  StudioEvalRunDetail,
  StudioEvalRunRequest,
  StudioEvalRunsAnswer,
  StudioGrant,
  StudioGrantRequest,
  StudioLoginAnswer,
  StudioLoginRequest,
  StudioPrincipal,
  StudioRole,
  StudioSessionDetail,
  StudioSessionFindAnswer,
  StudioSessionRaw,
  StudioSessionsAnswer,
  StudioSkillDetail,
  StudioSkillDiagnosticsAnswer,
  StudioSkillsAnswer,
  StudioSkillUpdateAnswer,
  StudioSkillUpdateRequest,
  StudioSystemAnswer,
  StudioToolsAnswer,
  StudioTraceLinkAnswer,
  StudioUsersAnswer,
} from '@lyteboat/contracts/studio'

/** A call the Studio refused, or one that did not reach it. */
class StudioApiCallError extends Error {
  constructor(readonly status: number, readonly code: StudioErrorCode | 'unreachable', message: string) {
    super(message)
  }
}

const studioApiSession: { token: string | undefined; unauthorized: () => void } = { token: undefined, unauthorized: () => {} }

/**
 * Set the token calls carry and what a 401 does.
 * @param token - the bearer token; undefined for gateway or anonymous access.
 * @param unauthorized - called when a call other than a login answers 401.
 */
export function configureStudioApi(token: string | undefined, unauthorized: () => void): void {
  studioApiSession.token = token
  studioApiSession.unauthorized = unauthorized
}

async function studioErrorOf(response: Response): Promise<StudioApiCallError> {
  try {
    const { error } = await response.json() as StudioErrorAnswer
    return new StudioApiCallError(response.status, error.code, error.message)
  } catch {
    return new StudioApiCallError(response.status, 'internal', `HTTP ${String(response.status)}`)
  }
}

async function studioCall<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown, signingIn = false, extraHeaders: Record<string, string> = {}): Promise<T> {
  let response: Response
  try {
    response = await fetch(`/api/studio/${path}`, {
      method,
      headers: {
        ...studioApiSession.token === undefined ? {} : { authorization: `Bearer ${studioApiSession.token}` },
        ...body === undefined ? {} : { 'content-type': 'application/json' },
        ...extraHeaders,
      },
      ...body === undefined ? {} : { body: JSON.stringify(body) },
    })
  } catch (error: unknown) {
    throw new StudioApiCallError(0, 'unreachable', `the Studio did not answer: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!response.ok) {
    if (response.status === 401 && !signingIn) studioApiSession.unauthorized()
    throw await studioErrorOf(response)
  }
  return await response.json() as T
}

/** POST a request whose answer is an event stream; a refusal throws as a JSON call's does. */
async function studioStream(path: string, body: unknown, signal: AbortSignal): Promise<ReadableStream<Uint8Array>> {
  let response: Response
  try {
    response = await fetch(`/api/studio/${path}`, {
      method: 'POST',
      headers: {
        ...studioApiSession.token === undefined ? {} : { authorization: `Bearer ${studioApiSession.token}` },
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal,
    })
  } catch (error: unknown) {
    if (signal.aborted) throw error
    throw new StudioApiCallError(0, 'unreachable', `the Studio did not answer: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!response.ok || response.body === null) {
    if (response.status === 401) studioApiSession.unauthorized()
    throw await studioErrorOf(response)
  }
  return response.body
}

/** One page of the Users table. */
interface StudioUsersQuery {
  text: string
  role: StudioRole | undefined
  limit: number
  offset: number
}

function usersQueryString(query: StudioUsersQuery): string {
  const params = new URLSearchParams({ limit: String(query.limit), offset: String(query.offset) })
  if (query.text !== '') params.set('text', query.text)
  if (query.role !== undefined) params.set('role', query.role)
  return params.toString()
}

/** A page of an agent's sessions: the window on `updatedAt` (epoch ms), one owner (`user:alice`), and the page. */
type StudioSessionsQuery = {
  since?: number
  until?: number
  owner?: string
  limit?: number
  offset?: number
}

/** A page of a search of an agent's sessions: the text (1 to 200 characters), the window, and the page. */
type StudioSessionsFindQuery = {
  q: string
  since?: number
  until?: number
  limit?: number
  offset?: number
}

/** A health window of the Dashboard (epoch ms): one agent or all, the bucket in minutes (else the server picks one), and the window to compare with. */
export type StudioDashboardHealthQuery = {
  from: number
  to: number
  agent?: string
  bucket?: number
  compareFrom?: number
  compareTo?: number
}

function studioQueryString(query: { [key: string]: string | number | undefined }): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value))
  }
  return params.toString()
}

function studioAgentPath(agentId: string): string {
  return `agents/${encodeURIComponent(agentId)}`
}

function studioSkillPath(agentId: string, name: string): string {
  return `${studioAgentPath(agentId)}/skills/${encodeURIComponent(name)}`
}

function studioSessionPath(agentId: string, sessionId: string): string {
  return `${studioAgentPath(agentId)}/sessions/${encodeURIComponent(sessionId)}`
}

function studioEvalRunPath(runId: string): string {
  return `evals/runs/${encodeURIComponent(runId)}`
}

/** The endpoints the pages call. */
export const studioApi = {
  authConfig: () => studioCall<StudioAuthConfigAnswer>('GET', 'auth/config'),
  login: (request: StudioLoginRequest) => studioCall<StudioLoginAnswer>('POST', 'auth/login', request, true),
  session: () => studioCall<StudioPrincipal>('GET', 'auth/session', undefined, true),
  logout: () => studioCall<Record<string, never>>('POST', 'auth/logout', {}, true),
  agents: () => studioCall<StudioAgentsAnswer>('GET', 'agents'),
  users: (query: StudioUsersQuery) => studioCall<StudioUsersAnswer>('GET', `users?${usersQueryString(query)}`),
  grant: (request: StudioGrantRequest) => studioCall<StudioGrant>('POST', 'users', request),
  revoke: (userId: string) => studioCall<StudioGrant>('DELETE', `users/${encodeURIComponent(userId)}`),
  system: () => studioCall<StudioSystemAnswer>('GET', 'system/properties'),
  traceLink: () => studioCall<StudioTraceLinkAnswer>('GET', 'config/trace-link'),
  skills: (agentId: string) => studioCall<StudioSkillsAnswer>('GET', `${studioAgentPath(agentId)}/skills`),
  skill: (agentId: string, name: string) => studioCall<StudioSkillDetail>('GET', studioSkillPath(agentId, name)),
  /** A hot-fix (admins), refused with `precondition_failed` when the file is no longer the one `sha256` names. */
  updateSkill: (agentId: string, name: string, request: StudioSkillUpdateRequest, sha256: string) =>
    studioCall<StudioSkillUpdateAnswer>('PUT', studioSkillPath(agentId, name), request, false, { 'if-match': sha256 }),
  diagnoseSkill: (agentId: string, name: string) => studioCall<StudioSkillDiagnosticsAnswer>('POST', `${studioSkillPath(agentId, name)}/diagnostics`),
  tools: (agentId: string) => studioCall<StudioToolsAnswer>('GET', `${studioAgentPath(agentId)}/tools`),
  /** Newest first by `updatedAt`; eval sessions are never listed. */
  sessions: (agentId: string, query: StudioSessionsQuery) =>
    studioCall<StudioSessionsAnswer>('GET', `${studioAgentPath(agentId)}/sessions?${studioQueryString(query)}`),
  findSessions: (agentId: string, query: StudioSessionsFindQuery) =>
    studioCall<StudioSessionFindAnswer>('GET', `${studioAgentPath(agentId)}/sessions/find?${studioQueryString(query)}`),
  /** Named apart from `session`, which reads the sign-in. */
  sessionDetail: (agentId: string, sessionId: string) => studioCall<StudioSessionDetail>('GET', studioSessionPath(agentId, sessionId)),
  sessionRaw: (agentId: string, sessionId: string) => studioCall<StudioSessionRaw>('GET', `${studioSessionPath(agentId, sessionId)}/raw`),
  /** Refused (`invalid_request`) for a window that ends before it starts or makes more than 500 buckets; `not_found` for an unknown agent. */
  dashboardHealth: (query: StudioDashboardHealthQuery) => studioCall<StudioDashboardHealth>('GET', `dashboard/health?${studioQueryString(query)}`),
  dashboardSummary: () => studioCall<StudioDashboardSummary>('GET', 'dashboard/summary'),
  dashboardRunning: () => studioCall<StudioDashboardRunning>('GET', 'dashboard/running'),
  /** Editors and admins: one test-window message; the stream is the turn's enterprise frames. */
  chat: (agentId: string, request: StudioChatRequest, signal: AbortSignal) => studioStream(`${studioAgentPath(agentId)}/chat`, request, signal),
  evalCases: (agentId: string) => studioCall<StudioEvalCasesAnswer>('GET', `${studioAgentPath(agentId)}/evals/cases`),
  /** Newest first. */
  evalRuns: (agentId: string) => studioCall<StudioEvalRunsAnswer>('GET', `evals/runs?${studioQueryString({ agent: agentId })}`),
  /** `cases` stays empty until the run is written. */
  evalRun: (runId: string) => studioCall<StudioEvalRunDetail>('GET', studioEvalRunPath(runId)),
  /** A is the baseline. */
  compareEvalRuns: (a: string, b: string) => studioCall<StudioEvalCompareAnswer>('GET', `evals/compare?${studioQueryString({ a, b })}`),
  /** Editors and admins; refused with `conflict` while the agent already runs one, or two runs are running. */
  startEvalRun: (request: StudioEvalRunRequest) => studioCall<StudioEvalRun>('POST', 'evals/runs', request),
  /** Editors and admins; `conflict` when the run is not running. */
  stopEvalRun: (runId: string) => studioCall<StudioEvalRun>('POST', `${studioEvalRunPath(runId)}/stop`),
  /** Editors and admins; `conflict` while the run is running. */
  deleteEvalRun: (runId: string) => studioCall<StudioEvalRunDeleted>('DELETE', studioEvalRunPath(runId)),
}

/** Why a caught error's Studio call was refused; undefined for an error that did not come from a call. */
export function studioErrorCode(error: unknown): StudioErrorCode | 'unreachable' | undefined {
  return error instanceof StudioApiCallError ? error.code : undefined
}

/** A caught error's message, for a page's error banner. */
export function studioErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
