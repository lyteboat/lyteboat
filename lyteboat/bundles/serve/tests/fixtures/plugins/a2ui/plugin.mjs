// A2UI composition fixture: `query_profile` folds a small profile into the session
// state through the tool policy's delta, and render_a2ui renders a card from that
// state. `finish` is a terminal card. Card fidelity against the reference lives in
// plugins/a2ui's own tests; this fixture proves the rows are wired in the serve composition.
import { fileURLToPath } from 'node:url'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'fixture-a2ui'
export const inject = ['toolPolicy', 'a2ui']

const PROFILE = { profile: { name: 'Composite Tester', total: '42.00' } }

export async function apply(ctx) {
  ctx.toolPolicy.register(defineTool({
    name: 'query_profile',
    description: 'Read the user profile into the session state for the summary card.',
    parameters: {},
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: `profile loaded: ${value.profile.name}` }],
    },
    execute: async () => PROFILE,
  }), { visibility: 'always', stateDelta: (_args, value) => value })

  await ctx.a2ui.registerRenderTool({
    templates: fileURLToPath(new URL('./templates', import.meta.url)),
    stateKeys: ['profile'],
    terminalCards: ['finish'],
    cardDescriptions: {
      summary: 'The profile summary card. Call query_profile first.',
      finish: 'The closing card; the turn ends after it.',
    },
  })
}
