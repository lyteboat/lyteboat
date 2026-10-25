/**
 * Which sessions belong to a caller, and archiving all of one owner's
 * sessions under one agent. A session is the caller's when it is not
 * archived, its recorded owner matches by id and kind, and it runs the
 * expected agent; `history()` reads only such a session and
 * `archiveSessions()` archives every one of them. Archiving goes through the
 * Workspace registry, the only way dsh has to retire a session: its log stays
 * on disk, dsh's archived-session gate runs no model step for it, and a
 * running turn is cancelled.
 * @module @lyteboat/chat-api/chat-owner-sessions
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-workspace'
import type { LyteboatRequestOwner, LyteboatRequestState } from '@lyteboat/contracts'
import { isChatSessionOwner } from './chat-session-owner.ts'

/** Whose sessions `chatApi.archiveSessions()` archives: one owner's, under one agent. */
export interface ChatSessionsArchiveRequest {
  /** The agent whose sessions go; the owner's sessions under other agents stay. */
  agentId: string
  /** Whose sessions go: the id and the kind both match. */
  owner: LyteboatRequestOwner
}

/** The dsh services the checks read and the archive writes. */
export type ChatOwnerSessionServices = Pick<Context, 'sessionController' | 'workspaceRegistry'>

/**
 * Whether a session is the caller's to read or continue.
 * @param services - the session controller and the Workspace registry.
 * @param sessionId - the session asked about.
 * @param owner - who asks.
 * @param agentId - the agent the caller expects the session to run.
 * @returns false when the session does not exist, is archived, belongs to another owner, or runs another agent.
 */
export async function isOwnChatSession(services: ChatOwnerSessionServices, sessionId: SessionId, owner: LyteboatRequestOwner, agentId: string): Promise<boolean> {
  if (services.workspaceRegistry.archivedSessionIds.includes(sessionId)) return false
  const projections = await services.sessionController.projections({ sessionId }, new AbortController().signal)
  if (projections === null) return false
  const recorded = (projections.values['lyteboatRequest'] as Partial<LyteboatRequestState> | undefined)?.owner
  return isChatSessionOwner(recorded, owner) && projections.values['agentPreset'] === agentId
}

/**
 * Archive every session of one owner under one agent, one at a time, each
 * with its running work stopped. Sessions created after the listing are not
 * archived. A failure propagates as thrown; the sessions archived before it
 * stay archived, and a second call skips them.
 * @param services - the session controller and the Workspace registry.
 * @param request - the agent and the owner.
 * @returns how many sessions this call archived.
 */
export async function archiveOwnerChatSessions(services: ChatOwnerSessionServices, request: ChatSessionsArchiveRequest): Promise<number> {
  const listing = await services.sessionController.list({}, new AbortController().signal)
  let archived = 0
  for (const { sessionId } of listing.items) {
    if (!await isOwnChatSession(services, sessionId, request.owner, request.agentId)) continue
    // Without stopActivity a running turn refuses the archive; the owner has left, so the turn stops.
    await services.workspaceRegistry.archiveSession(sessionId, { stopActivity: true })
    archived++
  }
  return archived
}
