/**
 * lyteboat extension `headless-hooks` (dsh-compat/contract/extensions.yml): the
 * runner's start, submit, and report plans, as the official runner has them
 * when nothing listens and as a listener leaves them.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, CreateAgentOptions, ResumeAgentOptions } from '@deepseek-ai/dsh-agent'
import AgentDefaultModelConfig from '@deepseek-ai/dsh-agent-default-model'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionId, UserMessage } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'
import { apply } from '../../src/index.ts'
import { internals } from '../../src/runner-internals.ts'

const originalInternals = { ...internals }
afterEach(() => { Object.assign(internals, originalInternals) })

const CWD = '/work'

/** The stored Session a `--session-id` run observes. */
interface StoredHeader {
  cwd: string
  agentPreset?: string
}

interface HookBench {
  ctx: Context
  created: CreateAgentOptions[]
  delivered: UserMessage[]
  run(options?: { sessionId?: string; json?: boolean }): Promise<{ code: number; out: string; err: string }>
}

/** One answered turn for each message the Agent receives. */
function answer(session: Session, message: UserMessage): void {
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('user/message', message, { surfaceOp: 'append' })
  session.append('assistant/message', {
    stream: [], turn: 1, step: 1,
    message: createAssistantMessage({ content: [{ type: 'text', text: 'answer' }], source: { provider: 'test-provider', model: 'test-model' } }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
}

/** The real registries around a scripted Agent factory that records what the runner asked of it. */
async function hookBench(stored?: StoredHeader): Promise<HookBench> {
  const ctx = new Context()
  ctx.provide('fs', { resolve: async () => ({ targetKey: CWD, displayPath: CWD }), processPath: () => CWD } as never)
  const created: CreateAgentOptions[] = []
  const delivered: UserMessage[] = []
  const mount = async (ownerCtx: Context, session: Session, options: CreateAgentOptions | ResumeAgentOptions): Promise<Agent> => {
    let idle = Promise.resolve()
    const agent: Agent = {
      id: session.id, options: options.agentOptions ?? {}, session, inbox: createInboxStub(), status: 'idle', ctx: ownerCtx,
      cancel: () => {},
      runMaintenance: () => Promise.reject(new Error('not used')),
      send: () => {},
      followup: (message: UserMessage) => {
        delivered.push(message)
        idle = Promise.resolve().then(() => { answer(session, message) })
      },
      steer: () => {},
      inject: () => {},
      whenIdle: () => idle,
    }
    await options.setup?.(ownerCtx, agent)
    await ctx.agents.register(agent)
    return agent
  }
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentDefaultModelConfig, { provider: 'test-provider', model: 'test-model' })
  ctx.agents.setFactory({
    async createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> {
      created.push(options)
      const session = ctx.sessions.create(options.sessionId, {
        ...options.meta === undefined ? {} : { meta: options.meta },
        ...options.seed === undefined ? {} : { seed: options.seed },
        ...options.inheritedEventCount === undefined ? {} : { inheritedEventCount: options.inheritedEventCount },
      })
      return { agent: await mount(ownerCtx, session, options), dispose: () => Promise.resolve() }
    },
    async resume(ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle> {
      const session = ctx.sessions.get(options.resumeSessionId)
      if (session === undefined) throw new Error(`no attached Session ${options.resumeSessionId}`)
      return { agent: await mount(ownerCtx, session, options), dispose: () => Promise.resolve() }
    },
  })
  if (stored !== undefined) {
    ctx.provide('sessionQuery', { observeSession: () => Promise.resolve({ header: stored, events: [], [Symbol.dispose]() {} }) } as never)
  }
  ctx.provide('sessionPersistence', {} as never)
  return {
    ctx,
    created,
    delivered,
    run: async (options = {}) => {
      let out = ''
      let err = ''
      internals.stdout = { write: (chunk: string) => { out += chunk; return true } }
      internals.stderr = { write: (chunk: string) => { err += chunk; return true } }
      const exited = new Promise<number>((resolve) => { ctx.provide('appExit', resolve) })
      apply(ctx, { task: 'do the thing', ...options })
      const code = await exited
      return { code, out, err }
    },
  }
}

/** Closed events of an earlier conversation, as a seed. */
function seedEvents(ctx: Context): SessionEvent[] {
  const source = ctx.sessions.create(brandString<SessionId>('seed-source'))
  answer(source, createUserMessage({ content: [{ type: 'text', text: 'earlier' }], source: { kind: 'user' } }))
  return Array.from({ length: source.seq }, (_, seq) => {
    const event = source.eventAt(SessionSeq(seq))
    if (event === undefined) throw new Error(`seed source has no seq ${String(seq)}`)
    return event
  })
}

describe('headless-hooks', () => {
  it('the runner creates the Agent from the official plan when nothing listens', async () => {
    const bench = await hookBench()

    const result = await bench.run()

    expect(result).toEqual({ code: 0, out: 'answer\n', err: '' })
    expect(bench.created).toHaveLength(1)
    expect(bench.created[0]?.meta).toEqual({ cwd: CWD })
    expect(bench.created[0]).not.toHaveProperty('seed')
    expect(bench.created[0]).not.toHaveProperty('inheritedEventCount')
    expect(bench.delivered.map(message => message.source)).toEqual([{ kind: 'user' }])
    await bench.ctx.fiber.dispose()
  })

  it('lyteboat/headless-start places, composes, and seeds a new Session', async () => {
    const bench = await hookBench()
    const seed = seedEvents(bench.ctx)
    const joined: Agent[] = []
    bench.ctx.on('lyteboat/headless-start', async (plan, next) => {
      const inner = plan.setup
      plan.cwd = '/agents/advisor'
      plan.agentPreset = 'advisor'
      plan.seed = seed
      plan.setup = async (agentCtx, agent) => {
        await inner(agentCtx, agent)
        joined.push(agent)
      }
      await next()
    })

    const result = await bench.run()

    expect(result.code).toBe(0)
    expect(bench.created[0]?.meta).toEqual({ cwd: '/agents/advisor', agentPreset: 'advisor', isSeeded: true })
    expect(bench.created[0]?.seed).toBe(seed)
    expect(bench.created[0]?.inheritedEventCount).toBe(seed.length)
    expect(joined.map(agent => agent.session.header.cwd)).toEqual(['/agents/advisor'])
    await bench.ctx.fiber.dispose()
  })

  it('a continued Session is adopted when it runs under the start plan\'s agent preset', async () => {
    const bench = await hookBench({ cwd: '/agents/advisor', agentPreset: 'advisor' })
    bench.ctx.sessions.create(brandString<SessionId>('session-stored'), { meta: { cwd: '/agents/advisor', agentPreset: 'advisor' } })
    bench.ctx.on('lyteboat/headless-start', async (plan, next) => {
      plan.cwd = '/agents/advisor'
      plan.agentPreset = 'advisor'
      await next()
    })

    const result = await bench.run({ sessionId: 'session-stored' })

    expect(result).toEqual({ code: 0, out: 'answer\n', err: '' })
    expect(bench.created).toEqual([])
    await bench.ctx.fiber.dispose()
  })

  it.each([
    [undefined, 'session "session-stored" runs under no agent preset, so it cannot be continued under agent preset "advisor"'],
    ['planner', 'session "session-stored" runs under agent preset "planner", so it cannot be continued under agent preset "advisor"'],
  ])('a continued Session under agent preset %s is refused when the start plan composes another', async (stored, message) => {
    const bench = await hookBench({ cwd: '/agents/advisor', ...stored === undefined ? {} : { agentPreset: stored } })
    bench.ctx.on('lyteboat/headless-start', async (plan, next) => {
      plan.cwd = '/agents/advisor'
      plan.agentPreset = 'advisor'
      await next()
    })

    const result = await bench.run({ sessionId: 'session-stored' })

    expect(result).toEqual({ code: 1, out: '', err: `dsh: ${message}\n` })
    expect(bench.delivered).toEqual([])
    await bench.ctx.fiber.dispose()
  })

  it('a continued Session takes no seed', async () => {
    const bench = await hookBench({ cwd: CWD })
    const seed = seedEvents(bench.ctx)
    bench.ctx.on('lyteboat/headless-start', async (plan, next) => {
      plan.seed = seed
      await next()
    })

    const result = await bench.run({ sessionId: 'session-stored' })

    expect(result.code).toBe(1)
    expect(result.err).toBe('dsh: session "session-stored" is continued, so it takes no seed; a seed starts a new Session\n')
    await bench.ctx.fiber.dispose()
  })

  it('a continued Session takes an empty seed as no seed', async () => {
    const bench = await hookBench({ cwd: CWD })
    bench.ctx.sessions.create(brandString<SessionId>('session-stored'), { meta: { cwd: CWD } })
    bench.ctx.on('lyteboat/headless-start', async (plan, next) => {
      plan.seed = []
      await next()
    })

    const result = await bench.run({ sessionId: 'session-stored' })

    expect(result).toEqual({ code: 0, out: 'answer\n', err: '' })
    await bench.ctx.fiber.dispose()
  })

  it('lyteboat/headless-submit delivers the task in place of the official user message', async () => {
    const bench = await hookBench()
    bench.ctx.on('lyteboat/headless-submit', async (plan, next) => {
      plan.deliver = () => {
        plan.agent.followup(createUserMessage({ content: [{ type: 'text', text: `[admitted] ${plan.task}` }], source: { kind: 'user' } }))
        return Promise.resolve()
      }
      await next()
    })

    const result = await bench.run()

    expect(result.code).toBe(0)
    expect(bench.delivered.map(message => message.content)).toEqual([[{ type: 'text', text: '[admitted] do the thing' }]])
    await bench.ctx.fiber.dispose()
  })

  it.each([false, true])('lyteboat/headless-report rewrites the answer the runner prints (json: %s)', async (json) => {
    const bench = await hookBench()
    bench.ctx.on('lyteboat/headless-report', async (plan, next) => {
      plan.text = `${plan.text} (reported after seq ${String(plan.firstSeq)}, ${plan.reason?.kind ?? 'no turn'})`
      await next()
    })

    const result = await bench.run({ json })

    const printed = json ? JSON.parse(result.out.trim().split('\n').at(-1) ?? '') : result.out
    expect(printed).toEqual(json ? { type: 'final', text: 'answer (reported after seq 0, completed)' } : 'answer (reported after seq 0, completed)\n')
    await bench.ctx.fiber.dispose()
  })
})
