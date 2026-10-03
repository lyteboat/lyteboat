// The routed agent's definition: its persona, its own skills under skills/
// (a business composition lends an agent no skill root), dynamic skill
// routing, and the official todo_write tool, which its composition brings as a
// dsh row, made `auto` so a skill can require it.
import { lyteboatAgentDef } from '@lyteboat/agent-def'

export default lyteboatAgentDef({
  agentId: 'routed',
  agentName: '技能路由示例',
  persona: {
    prefix: 'You are ROUTED-PRESET-PERSONA, a test agent powered by the {{model}} model.',
    suffix: 'Your working directory is {{cwd}}.',
  },
  skillDirs: ['skills'],
  skillRouting: { mode: 'dynamic', historyWindow: 6, timeoutMs: 10000 },
  toolPolicy: { tools: { todo_write: { visibility: 'auto' } } },
})
