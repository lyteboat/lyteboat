/**
 * @lyteboat/session-index — an agent's stored sessions, read for the Studio:
 * the sessions of the agent's working directory whose requests name no other
 * agent, newest first, a page at a time within a time window and optionally
 * of one owner (only end users' and operators' sessions are listed: an eval
 * run, owner kind `system`, is not, nor a session no request owns); a bounded
 * search (the 500 newest sessions of the window) by session id, human message,
 * or trace id; one session folded into its timeline; and one session as
 * stored. Everything is read through `sessionPersistence` with read handles,
 * which never take a session's write ownership, so it runs beside the serve
 * process that writes them. A session's fold is cached by its revision, and an
 * agent's listing is reused for two seconds.
 * @module @lyteboat/session-index
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { SessionPersistenceNotFoundError, type SessionHandle, type SessionPersistenceRevision, type SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence'
import type { AgentCatalogEntry } from '@lyteboat/agent-catalog'
import type { JsonValue, LyteboatRequestOwner } from '@lyteboat/contracts'
import type {
  StudioSessionDetail,
  StudioSessionFindAnswer,
  StudioSessionMatch,
  StudioSessionRaw,
  StudioSessionsAnswer,
  StudioSessionSummary,
} from '@lyteboat/contracts/studio'
import type {} from '@lyteboat/turn-outcome'
import { foldSession, type SessionSearchFacts } from './session-fold.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionIndex: SessionIndexService
  }
}

/** Which sessions a listing or a search covers, and which page of them. */
export interface SessionIndexQuery {
  /** Only sessions updated at or after this time (epoch ms). */
  since?: number
  /** Only sessions updated at or before this time (epoch ms). */
  until?: number
  owner?: LyteboatRequestOwner
  limit: number
  offset: number
}

/** A search looks into at most this many of the newest sessions in its window (the original Studio's bound). */
const SESSION_FIND_CANDIDATES = 500

const SESSION_LISTING_REUSE_MS = 2_000
const SESSION_MATCH_SNIPPET_CHARS = 200

interface IndexedSession {
  summary: StudioSessionSummary
  search: SessionSearchFacts
}

/** One session as stored. */
interface StoredSession {
  header: SessionHeader
  inheritedEventCount: number
  events: readonly SessionEvent[]
}

function inWindow(summary: StudioSessionSummary, query: SessionIndexQuery): boolean {
  if (query.since !== undefined && summary.updatedAt < query.since) return false
  if (query.until !== undefined && summary.updatedAt > query.until) return false
  const { owner } = query
  return owner === undefined || (summary.owner?.kind === owner.kind && summary.owner.id === owner.id)
}

function matchOf(session: IndexedSession, text: string): Pick<StudioSessionMatch, 'matchKind' | 'matchedSnippet'> | undefined {
  const wanted = text.toLowerCase()
  if (session.summary.sessionId.toLowerCase().includes(wanted)) return { matchKind: 'session', matchedSnippet: session.summary.sessionId }
  const question = session.search.questions.find(candidate => candidate.toLowerCase().includes(wanted))
  if (question !== undefined) {
    return { matchKind: 'question', matchedSnippet: question.length <= SESSION_MATCH_SNIPPET_CHARS ? question : `${question.slice(0, SESSION_MATCH_SNIPPET_CHARS)}…` }
  }
  const traceId = session.search.traceIds.find(candidate => candidate.toLowerCase().includes(wanted))
  return traceId === undefined ? undefined : { matchKind: 'trace', matchedSnippet: traceId }
}

/** Host service: an agent's stored sessions, read only. */
export class SessionIndexService extends Service {
  static inject = ['sessionPersistence', 'agentCatalog', 'turnOutcome']

  private readonly folds = new Map<string, { revision: SessionPersistenceRevision; session: IndexedSession }>()
  private readonly listings = new Map<string, { at: number; sessions: IndexedSession[] }>()

  constructor(ctx: Context) {
    super(ctx, 'sessionIndex')
  }

  /**
   * A page of an agent's sessions, newest first.
   * @param agentId - an agent the catalog serves.
   * @param query - the window, the owner, and the page.
   * @returns undefined for an unknown agent.
   */
  async list(agentId: string, query: SessionIndexQuery): Promise<StudioSessionsAnswer | undefined> {
    const sessions = await this.sessionsOf(agentId)
    if (sessions === undefined) return undefined
    const shown = sessions.filter(session => inWindow(session.summary, query))
    return {
      sessions: shown.slice(query.offset, query.offset + query.limit).map(session => session.summary),
      total: shown.length,
      hasMore: query.offset + query.limit < shown.length,
    }
  }

  /**
   * A page of the sessions whose id, human messages, or trace ids hold `text`
   * (case-insensitively), among the newest {@link SESSION_FIND_CANDIDATES} of the window.
   * @param agentId - an agent the catalog serves.
   * @param text - what to look for.
   * @param query - the window, the owner, and the page.
   * @returns undefined for an unknown agent.
   */
  async find(agentId: string, text: string, query: SessionIndexQuery): Promise<StudioSessionFindAnswer | undefined> {
    const sessions = await this.sessionsOf(agentId)
    if (sessions === undefined) return undefined
    const matches: StudioSessionMatch[] = []
    for (const session of sessions.filter(candidate => inWindow(candidate.summary, query)).slice(0, SESSION_FIND_CANDIDATES)) {
      const match = matchOf(session, text)
      if (match !== undefined) matches.push({ ...session.summary, ...match })
    }
    return { sessions: matches.slice(query.offset, query.offset + query.limit), hasMore: query.offset + query.limit < matches.length }
  }

  /**
   * One session of the agent folded into its timeline.
   * @param agentId - an agent the catalog serves.
   * @param sessionId - one of its sessions.
   * @returns undefined for an unknown agent, or a session that is not the agent's.
   */
  async detail(agentId: string, sessionId: string): Promise<StudioSessionDetail | undefined> {
    const stored = await this.storedOf(agentId, sessionId)
    if (stored === undefined) return undefined
    const folded = this.fold(stored)
    return this.belongs(folded, agentId) ? { summary: folded.summary, items: folded.items } : undefined
  }

  /**
   * One session of the agent as stored: its header and its events.
   * @param agentId - an agent the catalog serves.
   * @param sessionId - one of its sessions.
   * @returns undefined for an unknown agent, or a session that is not the agent's.
   */
  async raw(agentId: string, sessionId: string): Promise<StudioSessionRaw | undefined> {
    const stored = await this.storedOf(agentId, sessionId)
    if (stored === undefined) return undefined
    if (!this.belongs(this.fold(stored), agentId)) return undefined
    // Headers and events are lossless JSON by dsh's storage contract; the cast only widens their static types.
    return { header: stored.header as unknown as JsonValue, inheritedEventCount: stored.inheritedEventCount, events: stored.events as unknown as JsonValue[] }
  }

  /** One stored session folded, its turns' outcomes as the turn outcome folds the same log. */
  private fold(stored: StoredSession): ReturnType<typeof foldSession> {
    return foldSession(stored.header, stored.inheritedEventCount, stored.events, this.ctx.turnOutcome.fold(stored.inheritedEventCount, stored.events))
  }

  /**
   * An end user's or an operator's session of this agent. An eval run is the
   * system's; a session no request owns has no message to show (an eval that
   * broke after opening its case's session leaves one); a session whose
   * requests name another agent is that agent's.
   */
  private belongs(session: IndexedSession, agentId: string): boolean {
    const kind = session.summary.owner?.kind
    return (kind === 'user' || kind === 'operator') && session.search.agentIds.every(id => id === agentId)
  }

  private async entryOf(agentId: string): Promise<AgentCatalogEntry | undefined> {
    try {
      await this.ctx.agentCatalog.whenReady()
    } catch {
      // Not strict: a failed agent is simply not served; the others are.
    }
    return this.ctx.agentCatalog.get(agentId)
  }

  private async sessionsOf(agentId: string): Promise<IndexedSession[] | undefined> {
    const entry = await this.entryOf(agentId)
    if (entry === undefined) return undefined
    const reused = this.listings.get(agentId)
    if (reused !== undefined && Date.now() - reused.at < SESSION_LISTING_REUSE_MS) return reused.sessions
    const sessions: IndexedSession[] = []
    for (const snapshot of await this.ctx.sessionPersistence.list()) {
      if (snapshot.header.cwd !== entry.workdir) continue
      const session = await this.indexed(snapshot)
      if (session !== undefined && this.belongs(session, agentId)) sessions.push(session)
    }
    sessions.sort((a, b) => b.summary.updatedAt - a.summary.updatedAt || a.summary.sessionId.localeCompare(b.summary.sessionId))
    this.listings.set(agentId, { at: Date.now(), sessions })
    return sessions
  }

  private async indexed(snapshot: SessionPersistenceSnapshot): Promise<IndexedSession | undefined> {
    const cached = this.folds.get(snapshot.header.id)
    if (cached?.revision === snapshot.revision) return cached.session
    const stored = await this.read(snapshot.header.id)
    if (stored === undefined) return undefined
    const { summary, search } = this.fold(stored)
    const session = { summary, search }
    this.folds.set(snapshot.header.id, { revision: snapshot.revision, session })
    return session
  }

  private async storedOf(agentId: string, sessionId: string): Promise<StoredSession | undefined> {
    const entry = await this.entryOf(agentId)
    if (entry === undefined) return undefined
    const stored = await this.read(sessionId as SessionId)
    return stored?.header.cwd === entry.workdir ? stored : undefined
  }

  private async read(sessionId: SessionId): Promise<StoredSession | undefined> {
    let handle: SessionHandle
    try {
      handle = await this.ctx.sessionPersistence.open(sessionId, 'read')
    } catch (error: unknown) {
      // A session removed since the listing, or an id that never existed, reads as none; anything else is logged and skipped.
      if (!(error instanceof SessionPersistenceNotFoundError)) this.ctx.logger.warn(`lyteboat session index: cannot read ${sessionId}: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
    try {
      const { events } = await handle.read()
      return { header: handle.header, inheritedEventCount: handle.inheritedEventCount, events }
    } finally {
      await handle.close()
    }
  }
}

export default SessionIndexService
