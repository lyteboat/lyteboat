/**
 * G4's scripted scenarios: each one drives `dsh headless` through a distinct
 * path of the kernel (a plain answer, a tool round trip, reasoning blocks, a
 * retried request, a truncated answer, a tool set that changes between two
 * requests on a route with tool updates and on one without) with upstream's
 * mock model server.
 * @module dsh-compat/tests/scenarios/scenarios
 */

import { fileURLToPath } from 'node:url'
import type { SessionLogRecord } from '@lyteboat/testkit/session-log'
import type { OfficialScenario } from '../support/official-cli.ts'

/** One G4 run, and what its official log must show when the scenario's setup could fail the same way on both sides. */
export interface G4Scenario extends OfficialScenario {
  /** Reads the path facts from the official log; they must equal `expected`, so an unloaded fixture cannot pass as agreement. */
  witness?: { read: (records: readonly SessionLogRecord[]) => string[]; expected: readonly string[] }
}

const README = { 'README.md': '# compatibility workspace\n\nThe answer is forty-two.\n' }

/**
 * Two DeepSeek catalog routes that differ only in `toolUpdate`. Both read
 * system prompt updates in history, so whether a tool change starts a new
 * request series is visible in the log: a new series replaces the prompt
 * head, a continued one appends the new prompt.
 */
const TOOL_ROUTES = `- id: llm-deepseek
  config:
    models:
      - id: g4-addition-only
        systemPromptUpdate: in-history
        toolUpdate: addition-only
      - id: g4-no-tool-update
        systemPromptUpdate: in-history
`

const TOOL_SWITCH_PLUGIN = fileURLToPath(new URL('./fixtures/tool-switch.mjs', import.meta.url))

/** The log shape a decoded record is read through; the log is JSON, so every field is optional. */
interface ToolSwitchRecord {
  type?: string
  seq?: number
  surfaceOp?: 'append' | { op?: string }
  data?: {
    turn?: number
    step?: number
    reason?: string
    startsSeries?: boolean
    headerSeq?: number
    message?: { source?: { kind?: string }; content?: { type: string; toolName?: string }[] }
  }
}

/**
 * The nodes the tool switch shapes in step 2 of turn 1, one line each: the
 * system prompt commit, the request header, and the tool-registry message.
 * @param records - a decoded session log.
 * @returns the step's system, header, and developer nodes, described.
 */
function toolSwitchNodes(records: readonly SessionLogRecord[]): string[] {
  const lines: string[] = []
  let inStep = false
  let headerSeq: number | undefined
  // A decoded log is untyped JSON; the fields read here are dsh's documented envelope.
  for (const record of records as readonly ToolSwitchRecord[]) {
    const { type, data } = record
    if (type === 'step/start') inStep = data?.turn === 1 && data.step === 2
    if (type === 'step/end' && inStep) break
    if (!inStep || data === undefined) continue
    if (type === 'system/message') lines.push(`system/message ${record.surfaceOp === 'append' ? 'append' : record.surfaceOp?.op ?? 'off-surface'}`)
    if (type === 'request/header') {
      headerSeq = record.seq
      lines.push(`request/header ${data.reason ?? '?'}${data.startsSeries === true ? ' startsSeries' : ''}`)
    }
    if (type === 'developer/message') {
      const blocks = (data.message?.content ?? []).map(block => `${block.type} ${block.toolName ?? '?'}`).join(', ')
      const bound = data.headerSeq !== undefined && data.headerSeq === headerSeq ? ', headerSeq = that header' : ''
      lines.push(`developer/message ${data.message?.source?.kind ?? '?'}: ${blocks}${bound}`)
    }
  }
  return lines
}

/**
 * The model calls the fixture plugin's `g4_switch_tools`, which removes
 * `g4_retired` and adds `g4_added` (each with its prompt section), then
 * answers: the second request of the turn has a different tool set and prompt.
 */
function toolSwitch(name: string, model: string, expected: readonly string[]): G4Scenario {
  return {
    name,
    task: 'switch the tools, then answer',
    sequence: ['tool_call_success', 'success'],
    mock: { toolName: 'g4_switch_tools', toolArguments: '{}', successText: 'G4-TOOLS-SWITCHED' },
    files: README,
    patch: `- insert:\n    - id: g4-tool-switch\n      name: ${JSON.stringify(TOOL_SWITCH_PLUGIN)}\n${TOOL_ROUTES}`
      + `- id: agent-default-model\n  config:\n    provider: deepseek-official\n    model: ${model}\n`,
    witness: { read: toolSwitchNodes, expected },
  }
}

const TOOL_REGISTRY_UPDATE = 'developer/message tool-registry: tool-addition g4_added, tool-removal g4_retired, headerSeq = that header'

export const G4_SCENARIOS: readonly G4Scenario[] = [
  { name: 'answer', task: 'say hello', sequence: ['success'], mock: { successText: 'G4-ANSWER' }, files: README },
  {
    name: 'tool-read',
    task: 'read the readme and report',
    sequence: ['tool_call_success', 'success'],
    mock: { toolName: 'read', toolArguments: JSON.stringify({ file_path: 'README.md' }), successText: 'G4-TOOL' },
    files: README,
  },
  { name: 'reasoning', task: 'think, then answer', sequence: ['reasoning_success'], mock: { reasoningText: 'G4-THINKING', successText: 'G4-REASONED' }, files: README },
  { name: 'retry', task: 'answer after a transient failure', sequence: ['server_error', 'success'], mock: { successText: 'G4-RETRIED' }, files: README },
  { name: 'max-tokens', task: 'answer at length', sequence: ['max_tokens'], mock: { partialText: 'G4-TRUNCATED' }, files: README },
  // With toolUpdate the change continues the series: the new prompt is appended in history.
  toolSwitch('tool-switch-addition-only', 'g4-addition-only', ['system/message append', 'request/header change', TOOL_REGISTRY_UPDATE]),
  // Without it the change starts a new series: the prompt head is replaced and the header says so.
  toolSwitch('tool-switch-no-tool-update', 'g4-no-tool-update', ['system/message replace', 'request/header change startsSeries', TOOL_REGISTRY_UPDATE]),
]
