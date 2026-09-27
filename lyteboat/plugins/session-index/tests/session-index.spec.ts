/**
 * The session index over dsh's JSONL session store and the agent catalog:
 * an agent's sessions by working directory, newest first, paged, windowed,
 * and by owner, without eval runs, sessions no request owns, or sessions
 * another agent's requests name;
 * the bounded search; one session's timeline and its stored form; and a
 * listing that follows a session written after it.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentDefaultModelConfig from '@deepseek-ai/dsh-agent-default-model'
import AgentPresetRegistry from '@deepseek-ai/dsh-agent-preset-registry'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import AgentCatalogService from '@lyteboat/agent-catalog'
import type { LyteboatRequest } from '@lyteboat/contracts'
import SessionIndexService from '@lyteboat/session-index'
import { MockAdapter, createLyteboatUnitHost } from '@lyteboat/testing'
import { lyteboatTempDir } from '@lyteboat/testing/scratch'
import { SessionLogBuilder } from './session-log-builder.ts'

afterEach(() => { vi.useRealTimers() })

interface IndexFixture {
  ctx: Context
  workdir(agentId: string): string
  write(id: string, cwd: string, build: (log: SessionLogBuilder) => SessionLogBuilder, start?: number): Promise<void>
}

async function indexFixture(): Promise<IndexFixture> {
  const root = lyteboatTempDir('session-index')
  for (const id of ['alpha', 'beta']) {
    mkdirSync(join(root, 'agents', id), { recursive: true })
    writeFileSync(join(root, 'agents', id, 'agent.cordis.yml'), '[]\n')
  }
  const ctx = await createLyteboatUnitHost(new MockAdapter([]))
  await ctx.plugin(Loader)
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions') })
  await ctx.plugin(AgentPresetRegistry, { default: 'none' })
  await ctx.plugin(AgentDefaultModelConfig, { provider: 'mock', model: 'mock' })
  await ctx.plugin(AgentCatalogService, { roots: [join(root, 'agents')], workdirsDir: join(root, 'workdirs') })
  await ctx.plugin(SessionIndexService)
  await ctx.agentCatalog.whenReady()
  const workdir = (agentId: string): string => ctx.agentCatalog.get(agentId)?.workdir ?? ''
  const write: IndexFixture['write'] = async (id, cwd, build, start = 1_000) => {
    const log = build(new SessionLogBuilder(start))
    const handle = await ctx.sessionPersistence.create(log.header(id, cwd))
    await handle.append(log.events)
    await handle.close()
  }
  return { ctx, workdir, write }
}

const asked = (who: LyteboatRequest['owner'], extra: Partial<LyteboatRequest> = {}): LyteboatRequest => ({ ...who === undefined ? {} : { owner: who }, ...extra })
const alice = { kind: 'user' as const, id: 'alice' }
const bob = { kind: 'user' as const, id: 'bob' }

async function threeSessions(index: IndexFixture): Promise<void> {
  const alpha = index.workdir('alpha')
  await index.write('s-old', alpha, log => log.turnStart().stepStart().user('第一个问题', asked(alice, { traceId: 'trace-001' })).assistant('答').turnEnd(), 1_000)
  await index.write('s-mid', alpha, log => log.turnStart().stepStart().user('第二个问题', asked(bob)).assistant('答').turnEnd(), 2_000)
  await index.write('s-new', alpha, log => log.turnStart().stepStart().user('第三个问题', asked(alice)).assistant('答').turnEnd(), 3_000)
  await index.write('s-eval', alpha, log => log.turnStart().stepStart().user('eval case', asked({ kind: 'system', id: 'eval' })).assistant('答').turnEnd(), 4_000)
  await index.write('s-beta-named', alpha, log => log.turnStart().stepStart().user('sent to beta', asked(alice, { agent: { id: 'beta', digest: `sha256:${'0'.repeat(64)}` } })).turnEnd(), 5_000)
  await index.write('s-beta', index.workdir('beta'), log => log.turnStart().stepStart().user('beta question', asked(alice)).turnEnd(), 6_000)
  // An eval that broke after opening its case's session leaves it with no request, hence no owner.
  await index.write('s-orphan', alpha, log => log, 7_000)
}

describe('the session index', () => {
  it('lists an agent\'s sessions newest first, without eval runs, sessions no request owns, or sessions its requests address to another agent', async () => {
    const index = await indexFixture()
    await threeSessions(index)

    const answer = await index.ctx.sessionIndex.list('alpha', { limit: 50, offset: 0 })
    const orphan = await index.ctx.sessionIndex.detail('alpha', 's-orphan')

    expect(answer?.sessions.map(session => session.sessionId)).toEqual(['s-new', 's-mid', 's-old'])
    expect(orphan).toBeUndefined()
    expect(answer).toMatchObject({ total: 3, hasMore: false })
    expect(answer?.sessions[0]).toMatchObject({ owner: alice, firstMessage: '第三个问题', messageCount: 2, turnCount: 1, openTurn: false })
    expect((await index.ctx.sessionIndex.list('beta', { limit: 50, offset: 0 }))?.sessions.map(session => session.sessionId)).toEqual(['s-beta'])
  })

  it('pages, windows by the last update, and filters by owner', async () => {
    const index = await indexFixture()
    await threeSessions(index)

    const first = await index.ctx.sessionIndex.list('alpha', { limit: 2, offset: 0 })
    const second = await index.ctx.sessionIndex.list('alpha', { limit: 2, offset: 2 })
    const windowed = await index.ctx.sessionIndex.list('alpha', { since: 1_500, until: 2_500, limit: 50, offset: 0 })
    const bobs = await index.ctx.sessionIndex.list('alpha', { owner: bob, limit: 50, offset: 0 })

    expect(first).toMatchObject({ total: 3, hasMore: true })
    expect(first?.sessions.map(session => session.sessionId)).toEqual(['s-new', 's-mid'])
    expect(second?.sessions.map(session => session.sessionId)).toEqual(['s-old'])
    expect(second?.hasMore).toBe(false)
    expect(windowed?.sessions.map(session => session.sessionId)).toEqual(['s-mid'])
    expect(bobs?.sessions.map(session => session.sessionId)).toEqual(['s-mid'])
  })

  it('finds sessions by id, human message, or trace id, case-insensitively, and says where each matched', async () => {
    const index = await indexFixture()
    await threeSessions(index)

    const byQuestion = await index.ctx.sessionIndex.find('alpha', '问题', { limit: 2, offset: 0 })
    const byTrace = await index.ctx.sessionIndex.find('alpha', 'TRACE-001', { limit: 50, offset: 0 })
    const byId = await index.ctx.sessionIndex.find('alpha', 's-mid', { limit: 50, offset: 0 })
    const excluded = await index.ctx.sessionIndex.find('alpha', 'eval case', { limit: 50, offset: 0 })

    expect(byQuestion?.sessions.map(session => [session.sessionId, session.matchKind, session.matchedSnippet])).toEqual([['s-new', 'question', '第三个问题'], ['s-mid', 'question', '第二个问题']])
    expect(byQuestion?.hasMore).toBe(true)
    expect(byTrace?.sessions.map(session => [session.sessionId, session.matchKind])).toEqual([['s-old', 'trace']])
    expect(byId?.sessions.map(session => [session.sessionId, session.matchKind])).toEqual([['s-mid', 'session']])
    expect(excluded?.sessions).toEqual([])
  })

  it('answers one session\'s timeline and its stored form, and nothing for a session that is not the agent\'s', async () => {
    const index = await indexFixture()
    await threeSessions(index)

    const detail = await index.ctx.sessionIndex.detail('alpha', 's-old')
    const raw = await index.ctx.sessionIndex.raw('alpha', 's-old')

    expect(detail?.items.map(item => item.kind)).toEqual(['user', 'assistant', 'turn-end'])
    expect(detail?.summary).toMatchObject({ sessionId: 's-old', owner: alice })
    expect(raw?.header).toMatchObject({ id: 's-old', cwd: index.workdir('alpha') })
    expect(raw?.events).toHaveLength(6)
    for (const [agentId, sessionId] of [['alpha', 's-beta'], ['alpha', 's-eval'], ['alpha', 's-beta-named'], ['alpha', 'nope'], ['nobody', 's-old']] as const) {
      expect(await index.ctx.sessionIndex.detail(agentId, sessionId)).toBeUndefined()
      expect(await index.ctx.sessionIndex.raw(agentId, sessionId)).toBeUndefined()
    }
  })

  it('answers undefined for an agent the catalog does not serve', async () => {
    const index = await indexFixture()

    expect(await index.ctx.sessionIndex.list('nobody', { limit: 50, offset: 0 })).toBeUndefined()
    expect(await index.ctx.sessionIndex.find('nobody', 'x', { limit: 50, offset: 0 })).toBeUndefined()
  })

  it('reuses a listing for two seconds, then shows a session written since', async () => {
    const now = Date.now()
    vi.useFakeTimers({ toFake: ['Date'], now })
    const index = await indexFixture()
    await threeSessions(index)
    await index.ctx.sessionIndex.list('alpha', { limit: 50, offset: 0 })
    await index.write('s-later', index.workdir('alpha'), log => log.turnStart().stepStart().user('later', asked(alice)).turnEnd(), 9_000)

    const reused = await index.ctx.sessionIndex.list('alpha', { limit: 50, offset: 0 })
    vi.setSystemTime(now + 2_001)
    const fresh = await index.ctx.sessionIndex.list('alpha', { limit: 50, offset: 0 })

    expect(reused?.total).toBe(3)
    expect(fresh?.sessions.map(session => session.sessionId)).toEqual(['s-later', 's-new', 's-mid', 's-old'])
  })
})
