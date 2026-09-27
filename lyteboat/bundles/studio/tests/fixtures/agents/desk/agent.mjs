// The desk agent's definition: its persona, its skills under skills/, routed
// dynamically, and two tools of its own. `desk_clock` always reaches the model,
// `lookup_quote` only once the quote-lookup skill (which requires it) is active;
// every inherited tool but `skill` stays hidden.
import { defineTool } from '@deepseek-ai/dsh-tools'
import { lyteboatAgentDef } from '@lyteboat/agent-def'

const TEXT = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }

export default lyteboatAgentDef({
  agentId: 'desk',
  agentName: 'Desk',
  persona: { prefix: 'You are STUDIO-DESK, a test agent powered by the {{model}} model.' },
  skillDirs: ['skills'],
  skillRouting: { mode: 'dynamic' },
  toolPolicy: { inherited: 'hidden', tools: { skill: { visibility: 'always' } } },
  tools: () => [
    {
      definition: defineTool({
        name: 'desk_clock',
        description: '报当前时间。',
        parameters: {},
        output: TEXT,
        execute: async () => '09:30',
      }),
      visibility: 'always',
    },
    {
      definition: defineTool({
        name: 'lookup_quote',
        description: '按代码查报价。',
        parameters: { code: { type: 'string', required: true, description: '代码' } },
        output: TEXT,
        execute: async args => `${args.code}: 1.00`,
      }),
      visibility: 'auto',
    },
  ],
})
