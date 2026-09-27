/**
 * lyteboat's unit-test harness: the unit host (a context with dsh's invariants,
 * the dsh services, the kernel's agent loop, and a scripted adapter), the
 * in-process MockAdapter, and the follow-up step every agent-loop test takes. Tests
 * mount the lyteboat services under test on the host themselves, so their load
 * order stays the test's decision.
 * @module @lyteboat/testing
 */

import { join, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context, type FiberState, type Plugin } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import * as AgentInvariant from '@deepseek-ai/dsh-agent/invariant'
import * as AgentLoopInvariant from '@deepseek-ai/dsh-agent-loop/invariant'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness, type AgentLoopTestDependenciesOptions } from '@deepseek-ai/dsh-agent-loop-testkit'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { createUserMessage, type LlmAdapter, type UserMessage } from '@deepseek-ai/dsh-llm'
import { bindScopeParent, createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as SessionInvariant from '@deepseek-ai/dsh-session/invariant'
import { onTestFinished } from 'vitest'

export { MockAdapter, maxTokensResponse, textResponse, toolCallResponse, type HangAfter } from './mock-adapter.ts'

/** Configuration forwarded to the mounted dsh services. */
export type DshTestServicesOptions = AgentLoopTestDependenciesOptions

/**
 * Mount the dsh services the agent loop injects: llm, sessions, projections, system
 * prompt, tools, and the agent registry, through the kernel testkit's own
 * mounting. The context owns every service; a failed plugin load rejects and
 * leaves earlier services for the context to unwind.
 * @param ctx - test context that owns the mounted services.
 * @param options - service configuration, forwarded unchanged.
 * @returns after every service has activated.
 */
export async function mountDshTestServices(ctx: Context, options: DshTestServicesOptions = {}): Promise<void> {
  await mountAgentLoopTestDependencies(ctx, options)
}

/**
 * Build a unit host for the running test: a fresh context with dsh's invariant
 * registry and the session, agent, and agent-loop companions, the dsh services,
 * the kernel's agent loop, and `adapter` serving the `mock` provider. The host
 * disposes itself when the test finishes, so call it from a test body.
 * @param adapter - the scripted model.
 * @param options - dsh service configuration, forwarded unchanged.
 * @returns the host context; the test mounts the lyteboat services under test on it.
 */
export async function createLyteboatUnitHost(adapter: LlmAdapter, options: DshTestServicesOptions = {}): Promise<Context> {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(SessionInvariant)
  await ctx.plugin(AgentInvariant)
  await ctx.plugin(AgentLoopInvariant)
  await mountDshTestServices(ctx, options)
  await mountAgentLoopTestHarness(ctx)
  ctx.effect(() => ctx.llm.registerAdapter(['mock'], adapter))
  return ctx
}

/**
 * Follow up on an agent and wait until it is idle again.
 * @param agent - the agent under test.
 * @param input - the message, or the text of a plain user message.
 * @returns once the agent has settled every step the message started.
 */
export async function followUpAndWait(agent: Agent, input: string | UserMessage): Promise<void> {
  agent.followup(typeof input === 'string' ? createUserMessage({ content: [{ type: 'text', text: input }], source: { kind: 'user' } }) : input)
  await agent.whenIdle()
}

/** An agent directory's standing scope on the unit host. */
export interface AgentStandingScope {
  /** The scope key the host services layer the agent's declarations under. */
  readonly standingKey: object
  /**
   * Create an agent instance joined to the scope in its setup window, as a session of the agent is.
   * @param sessionId - the new session's id.
   * @returns the agent instance, on the `mock` provider.
   */
  createAgentInstance(sessionId: string): Promise<Agent>
}

/**
 * Mount an agent directory's row the way dsh's preset registry mounts it: in a
 * standing scope whose base URL is the agent directory. The host services the
 * row declares against must already be mounted on `ctx`.
 * @param ctx - the unit host.
 * @param agentDir - the agent directory; its rows resolve relative paths against it.
 * @param agentRow - the plugin the directory's row loads, such as its `lyteboatAgentDef`.
 * @returns the scope, once the row has mounted.
 * @throws when the row fails, or stays waiting for a service `ctx` does not have.
 */
export async function mountAgentStandingScope(ctx: Context, agentDir: string, agentRow: Plugin): Promise<AgentStandingScope> {
  const standingKey = {}
  const standing = createScope(ctx, standingKey)
  const rowFiber = await standing.ctx.extend({ baseUrl: pathToFileURL(join(agentDir, sep)).href }).plugin(agentRow)
  // cordis's `declare const enum`, which vitest's transform does not inline (see @lyteboat/cli/fiber-state).
  if (rowFiber.state !== (2 as FiberState.ACTIVE)) {
    const injected = agentRow.inject === undefined ? [] : Array.isArray(agentRow.inject) ? agentRow.inject : Object.keys(agentRow.inject)
    const missing = injected.filter(service => ctx.get(service) === undefined)
    throw new Error(`mountAgentStandingScope: the agent row is not active; mount on the unit host the services it waits for: ${missing.join(', ') || '(none missing; see the row\'s fiber)'}`)
  }
  return {
    standingKey,
    createAgentInstance: async (sessionId) => {
      const { agent } = await ctx.agents.create({
        sessionId: SessionId(sessionId),
        agentOptions: { provider: 'mock', model: 'mock' },
        setup: (agentCtx) => {
          const agentKey = scopeOf(agentCtx)
          if (agentKey === undefined) throw new Error('mountAgentStandingScope: the agent context has no scope')
          bindScopeParent(agentKey, standingKey)
        },
      })
      return agent
    },
  }
}
