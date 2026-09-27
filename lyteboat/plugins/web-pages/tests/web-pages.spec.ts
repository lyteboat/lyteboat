/**
 * The endpoints the web pages call, answered in process: dsh's connection
 * and session controller are stood in for at their boundary (the routes a
 * page's call reaches once dsh has let it through, the prompts it queues);
 * the agent catalog and the request context are the real services.
 */
import { cpSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import AgentDefaultModelConfig from '@deepseek-ai/dsh-agent-default-model'
import AgentPresetRegistry from '@deepseek-ai/dsh-agent-preset-registry'
import type { SessionPromptRequest } from '@deepseek-ai/dsh-api-session-controller/types'
import type { ConnectionFetchRoute, ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection'
import { MockAdapter, createLyteboatUnitHost } from '@lyteboat/testing'
import { lyteboatTempDir } from '@lyteboat/testing/scratch'
import AgentCatalogService from '@lyteboat/agent-catalog'
import RequestContextService from '@lyteboat/request-context'
import WebPagesService from '@lyteboat/web-pages'
import { listEvalRuns } from '../src/eval-runs.ts'

const fixture = (name: string): string => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))

/** What a page's call reaches, and what the session controller was asked. */
interface WebPagesHost {
  /** A call as dsh's browser transport makes it: `connection.rpc.call('/api', 'lyteboat/<endpoint>', payload)`. */
  call(endpoint: string, payload?: unknown): Promise<ConnectionRpcResult<unknown>>
  post(path: string, body: unknown): Promise<Response>
  prompts: SessionPromptRequest[]
  ctx: Context
}

async function webPagesHost(roots: string[]): Promise<WebPagesHost> {
  const ctx = await createLyteboatUnitHost(new MockAdapter([]))
  const routes = new Map<string, ConnectionFetchRoute>()
  const prompts: SessionPromptRequest[] = []
  // The unit host has no loader tree; the registry only waits on it to settle, and here it has.
  ctx.provide('loader', { await: () => Promise.resolve() } as never)
  // dsh's connection: the exact routes on its `/api` channel, reached once its fence and login let a call through.
  ctx.provide('connection', { fetch: { register: (route: ConnectionFetchRoute) => { routes.set(route.path, route); return () => Promise.resolve(routes.delete(route.path)).then(() => {}) } } } as never)
  // dsh's session controller: the prompts queued on a session.
  ctx.provide('sessionController', { prompt: (request: SessionPromptRequest) => { prompts.push(request); return Promise.resolve() } } as never)
  await ctx.plugin(AgentPresetRegistry, { default: 'none' })
  await ctx.plugin(AgentDefaultModelConfig, { provider: 'deepseek-official', model: 'deepseek-flash' })
  await ctx.plugin(AgentCatalogService, { roots, strict: false })
  await ctx.plugin(RequestContextService)
  await ctx.plugin(WebPagesService, { owner: 'web', evalsDir: fixture('evals') })
  const post = async (path: string, body: unknown): Promise<Response> => {
    const route = routes.get(path)
    if (route === undefined) return new Response('not found', { status: 404 })
    return route.fetch(new Request(`http://127.0.0.1${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))
  }
  const call = async (endpoint: string, payload: unknown = {}): Promise<ConnectionRpcResult<unknown>> => {
    const response = await post(`/api/lyteboat/${endpoint}`, { type: 'client-request', rpcId: 'rpc-1', method: `lyteboat/${endpoint}`, payload })
    const envelope = await response.json() as { type: string; rpcId: string; result: ConnectionRpcResult<unknown> }
    expect({ type: envelope.type, rpcId: envelope.rpcId }).toEqual({ type: 'server-response', rpcId: 'rpc-1' })
    return envelope.result
  }
  return { call, post, prompts, ctx }
}

describe('the web pages\' endpoints', () => {
  it('answers the agents the catalog serves, with their display fields, and the ones it cannot', async () => {
    const host = await webPagesHost([fixture('agents')])

    const answer = await host.call('agents')

    expect(answer).toEqual({
      ok: true,
      value: {
        agents: [{ id: 'support', name: 'Support', description: 'a fixture agent' }],
        failures: [{ id: 'Bad_Id', reason: '"Bad_Id" is not a kebab-case id; rename the directory' }],
      },
    })
  })

  it('reloads the catalog and answers the agents the roots hold now', async () => {
    const root = lyteboatTempDir('web-pages')
    const host = await webPagesHost([root])
    await host.ctx.agentCatalog.whenReady()
    cpSync(fixture('agents/support'), join(root, 'support'), { recursive: true })

    const answer = await host.call('agents/reload')

    expect(answer).toEqual({ ok: true, value: { agents: [{ id: 'support', name: 'Support', description: 'a fixture agent' }], failures: [] } })
  })

  it('queues a message through the session controller with its request context on the source', async () => {
    const host = await webPagesHost([fixture('agents')])

    const answer = await host.call('session/send', { sessionId: 'sess-1', text: '看看我的资产', context: { customer: 'young-idle-cash' } })

    expect(answer.ok).toBe(true)
    const requestId = answer.ok ? (answer.value as { requestId: string }).requestId : ''
    expect(host.prompts).toEqual([{
      requestId,
      sessionId: 'sess-1',
      mode: 'queue',
      content: [{ type: 'text', text: '看看我的资产' }],
      sourceFields: { lyteboatRequest: { requestId, owner: { kind: 'operator', id: 'web' }, context: { customer: 'young-idle-cash' } } },
    }])
  })

  it('refuses a blank message or an unknown field, and queues nothing', async () => {
    const host = await webPagesHost([fixture('agents')])

    const blank = await host.call('session/send', { sessionId: 'sess-1', text: '  ' })
    const unknown = await host.call('session/send', { sessionId: 'sess-1', text: 'hi', trace: 'x' })

    expect(blank).toEqual({ ok: false, error: { code: 'invalid_request', message: 'text: text must not be blank', details: {} } })
    expect(unknown).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
    expect(host.prompts).toEqual([])
  })

  it('lists the eval runs newest first, skipping a directory that is not a run and a run.json of an earlier format, and answers one run\'s report', async () => {
    const host = await webPagesHost([fixture('agents')])

    const runs = await host.call('evals')
    const report = await host.call('evals/report', { run: '20260925T010000Z-aaaa' })

    expect(runs).toEqual({
      ok: true,
      value: {
        runs: [
          { id: '20260925T020000Z-bbbb', agent: 'support', mode: 'replay', cases: 2, passedCases: 2, startedAt: '2026-09-25T02:00:00.000Z' },
          { id: '20260925T010000Z-aaaa', agent: 'support', mode: 'real', cases: 2, passedCases: 1, startedAt: '2026-09-25T01:00:00.000Z' },
        ],
      },
    })
    expect(report).toEqual({ ok: true, value: { run: '20260925T010000Z-aaaa', report: '# Eval support: 1/2 cases passed\n' } })
  })

  it('warns about a run.json of an earlier format instead of listing it', () => {
    const warnings: string[] = []

    const runs = listEvalRuns(fixture('evals'), (message) => { warnings.push(message) })

    expect(runs.map(run => run.id)).toEqual(['20260925T020000Z-bbbb', '20260925T010000Z-aaaa'])
    expect(warnings).toEqual([expect.stringMatching(/^web-pages: eval run 20260924T230000Z-cccc left out: .*run\.json is not a run\.json this lyteboat reads/u) as string])
  })

  it('refuses a report named by a path', async () => {
    const host = await webPagesHost([fixture('agents')])

    const escaped = await host.call('evals/report', { run: '../evals/20260925T010000Z-aaaa' })

    expect(escaped).toEqual({ ok: false, error: { code: 'not_found', message: 'no eval run "../evals/20260925T010000Z-aaaa"', details: {} } })
  })

  it('refuses a body that is not a client-request for the route\'s own endpoint', async () => {
    const host = await webPagesHost([fixture('agents')])

    const notEnvelope = await host.post('/api/lyteboat/agents', { agents: true })
    const otherMethod = await host.post('/api/lyteboat/agents', { type: 'client-request', rpcId: 'rpc-1', method: 'lyteboat/evals', payload: {} })

    expect([notEnvelope.status, otherMethod.status]).toEqual([400, 400])
  })
})
