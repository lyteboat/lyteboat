/**
 * The unit host: the invariants and the agent loop mounted, the adapter serving
 * the `mock` provider, and the host gone once the test that built it finishes.
 */
import { describe, expect, it } from 'vitest'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { MockAdapter, createLyteboatUnitHost, followUpAndWait, textResponse } from '../src/index.ts'

describe('createLyteboatUnitHost', () => {
  let disposed = false

  it('createLyteboatUnitHost answers a plain follow-up through the adapter when an agent runs on the mock provider', async () => {
    const adapter = new MockAdapter([textResponse('hello back')])
    const ctx = await createLyteboatUnitHost(adapter)
    ctx.effect(() => () => { disposed = true })
    const agent = await ctx.agentLoop.create(SessionId('unit-host'), { provider: 'mock', model: 'mock' })

    await followUpAndWait(agent, 'hello')

    expect(ctx.get('invariants')).toBeDefined()
    expect(adapter.requests).toHaveLength(1)
    expect(agent.session.snapshotEvents().filter((event): event is SessionEvent<'user/message'> => event.type === 'user/message').map(event => event.data.source)).toEqual([{ kind: 'user' }])
    expect(disposed).toBe(false)
  })

  it('createLyteboatUnitHost disposes the host when the test that built it finishes', () => {
    expect(disposed).toBe(true)
  })
})
