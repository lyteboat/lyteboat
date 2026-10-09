// The policy agent's definition: its persona, and a tool policy that hides
// everything it inherits from the host but the official todo_write tool, which
// its composition brings as a dsh row.
import { lyteboatAgentDef } from '@lyteboat/agent-def'

export default lyteboatAgentDef({
  agentId: 'policy',
  agentName: '工具策略示例',
  persona: { prefix: 'You are POLICY-PRESET-PERSONA, a test agent powered by the {{model}} model.' },
  toolPolicy: { inherited: 'hidden', tools: { todo_write: { visibility: 'always' } } },
})
