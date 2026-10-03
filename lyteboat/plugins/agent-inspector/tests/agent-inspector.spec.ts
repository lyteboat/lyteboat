/**
 * The agent inspector: an agent's tools, skills, and routing read from its
 * standing scope, the way a new instance of it would see them, without
 * creating one.
 */
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentDefaultModelConfig from '@deepseek-ai/dsh-agent-default-model'
import AgentPresetRegistry from '@deepseek-ai/dsh-agent-preset-registry'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import AgentCatalogService from '@lyteboat/agent-catalog'
import AgentInspectorService from '@lyteboat/agent-inspector'
import LyteboatDistroService from '@lyteboat/distro'
import ModelSideCallService from '@lyteboat/model-side-call'
import SkillRouterService from '@lyteboat/skill-router'
import { MockAdapter, createLyteboatUnitHost } from '@lyteboat/testkit'
import ToolPolicyService from '@lyteboat/tool-policy'

const agentsRoot = fileURLToPath(new URL('./fixtures/agents', import.meta.url))

async function inspectorHost(): Promise<Context> {
  const ctx = await createLyteboatUnitHost(new MockAdapter([]))
  // The registry mounts an agent's rows through a Loader tree of its own.
  await ctx.plugin(Loader)
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(LyteboatDistroService)
  await ctx.plugin(ToolPolicyService)
  await ctx.plugin(ModelSideCallService)
  await ctx.plugin(SkillRouterService, {})
  await ctx.plugin(AgentPresetRegistry, { default: 'none' })
  await ctx.plugin(AgentDefaultModelConfig, { provider: 'mock', model: 'mock' })
  await ctx.plugin(AgentCatalogService, { roots: [agentsRoot], workdirsDir: '/srv/lyteboat/workdirs' })
  await ctx.plugin(AgentInspectorService)
  // A host tool every agent inherits; the counter agent hides the inherited ones.
  ctx.tools.register(defineContentToolFixture({ name: 'host_tool', description: 'host tool', parameters: {}, execute: async () => [] }))
  return ctx
}

describe('the agent inspector', () => {
  it('answers each tool of an agent with its declaration, how it reaches the model, and the skills that require it', async () => {
    const ctx = await inspectorHost()

    const tools = await ctx.agentInspector.tools('counter')

    expect(tools?.map(({ name, declared, reach, requiredBy }) => ({ name, declared, reach, requiredBy })).sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: 'count_clock', declared: 'always', reach: 'always', requiredBy: [] },
      { name: 'count_items', declared: 'auto', reach: 'activated', requiredBy: ['audit-trail', 'item-count'] },
      { name: 'host_tool', declared: 'inherited', reach: 'hidden', requiredBy: [] },
    ])
    expect(tools?.find(tool => tool.name === 'count_clock')).toMatchObject({ description: 'count_clock tool', parameters: { type: 'object' } })
  })

  it('answers the skills sorted by name with their required tools and the agent\'s routing', async () => {
    const ctx = await inspectorHost()

    const answer = await ctx.agentInspector.skills('counter')

    expect(answer?.routing).toEqual({ mode: 'dynamic', provider: 'mock', model: 'router' })
    expect(answer?.skills.map(skill => skill.name)).toEqual(['audit-trail', 'broken-meta', 'item-count'])
    expect(answer?.skills[0]).toEqual({
      name: 'audit-trail', description: 'read the audit trail', whenToUse: 'when asked who changed what',
      modelInvocable: true, userInvocable: true, requiredTools: ['count_items', 'missing_tool'],
    })
  })

  it('reports lyteboat metadata that does not parse instead of dropping the skill', async () => {
    const ctx = await inspectorHost()

    const broken = (await ctx.agentInspector.skills('counter'))?.skills.find(skill => skill.name === 'broken-meta')

    expect(broken?.requiredTools).toEqual([])
    expect(broken?.metadataProblem).toMatch(/^metadata\.lyteboat\.requiredTools: /u)
  })

  it('answers one skill with the body the model loads', async () => {
    const ctx = await inspectorHost()

    const skill = await ctx.agentInspector.skill('counter', 'item-count')

    expect(skill).toMatchObject({ name: 'item-count', requiredTools: ['count_items'], content: 'BODY-COUNT' })
    expect(await ctx.agentInspector.skill('counter', 'no-such-skill')).toBeUndefined()
  })

  it('checks every skill against the agent\'s tools and routing, naming the tools a rule failed on', async () => {
    const ctx = await inspectorHost()

    const findings = await ctx.agentInspector.findings('counter')

    const failed = findings?.map(({ skill, findings: checks }) => ({ skill, failed: checks.filter(check => !check.passed).map(({ rule, tools, problem }) => ({ rule, tools, problem })) }))
    expect(failed).toEqual([
      { skill: 'audit-trail', failed: [{ rule: 'required-tools-registered', tools: ['missing_tool'], problem: undefined }] },
      { skill: 'broken-meta', failed: [{ rule: 'metadata-valid', tools: [], problem: expect.stringMatching(/^metadata\.lyteboat\.requiredTools: /u) }] },
      { skill: 'item-count', failed: [] },
    ])
    expect(findings?.[0]?.findings.map(check => check.rule)).toEqual(['metadata-valid', 'required-tools-registered', 'required-tools-declared', 'required-tools-auto', 'routable'])
  })

  it('answers undefined for an agent the catalog does not serve', async () => {
    const ctx = await inspectorHost()

    expect(await ctx.agentInspector.tools('nobody')).toBeUndefined()
    expect(await ctx.agentInspector.skills('nobody')).toBeUndefined()
    expect(await ctx.agentInspector.skill('nobody', 'item-count')).toBeUndefined()
    expect(await ctx.agentInspector.findings('nobody')).toBeUndefined()
  })

  it('reads the host view outside any agent: an agent\'s own tools and skills stay in its scope', async () => {
    const ctx = await inspectorHost()
    await ctx.agentInspector.tools('counter')

    expect(ctx.tools.schemas(undefined).map(schema => schema.name)).toEqual(['host_tool'])
    expect((await ctx.skills.list({})).map(skill => skill.name)).toEqual([])
  })
})
