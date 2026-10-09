import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { postChat } from '@lyteboat/testkit/chat-client'
import { LYTEBOAT_SERVE_BUNDLES, pluginFileRow, startComposition, type PatchOptions, type RunningComposition } from '@lyteboat/testkit/composition'
import type { LyteboatScratch } from '@lyteboat/testkit/scratch'
import { scriptedModelEnv, type RecordedRequest } from '@lyteboat/testkit/scripted-model'
import { waitForSessionLog, type SessionLogRecord } from '@lyteboat/testkit/session-log'

const PLUGINS = fileURLToPath(new URL('../fixtures/plugins', import.meta.url))

/** The agents that exercise the business base's services: `minimal` (a persona, inheriting the host's tools), `policy`, and `routed`. */
const BASE_AGENTS = fileURLToPath(new URL('../fixtures/base-agents', import.meta.url))

/** A session log record as these tests read it. */
export type BaseLogRecord = SessionLogRecord & { type: string; ignorable?: true; data?: { [key: string]: unknown } }

/** A serve composition over {@link BASE_AGENTS}, and what a test talks to it with. */
export interface ServedBaseAgents {
  serve: RunningComposition
  /** The `/chat` URL. */
  chat: string
  home: string
  workspace: string
  /** Post one message to `agent` in a new session (or `sessionId`'s), and read its log once the turn ended. */
  ask(agent: string, message: string, extra?: { [key: string]: unknown }): Promise<{ body: ChatReplyBody; records: BaseLogRecord[] }>
}

/** The fields of a `/chat` JSON reply these tests read. */
interface ChatReplyBody {
  session_id: string
  outcome: string
  response: string
  cards: { area: string }[]
  tool_calls: { name: string }[]
}

/**
 * Serve the base agents in process, the way `lyteboat serve --agents <base-agents> --port 0` would.
 * @param scratch - the test file's temporary tree.
 * @param model - where the scripted model listens.
 * @param patches - layers above the bundles (plugin-file rows).
 * @param files - files of the serve process's working directory.
 * @returns the running service, once it printed where `/chat` listens.
 */
export async function serveBaseAgents(scratch: LyteboatScratch, model: { readonly baseURL: string }, patches: readonly PatchOptions[] = [], files?: Readonly<Record<string, string>>): Promise<ServedBaseAgents> {
  const { home, workspace } = scratch.run('serve', files)
  const serve = startComposition({ bundles: LYTEBOAT_SERVE_BUNDLES, args: ['--agents', BASE_AGENTS, '--port', '0'], patches, cwd: workspace, home, env: scriptedModelEnv(model), timeoutMs: 170_000 })
  const chat = (await serve.waitForStdout(/^lyteboat serve: (http:\/\/\S+\/chat) /mu))[1] ?? ''
  const turns = new Map<string, number>()
  return {
    serve,
    chat,
    home,
    workspace,
    async ask(agent, message, extra = {}) {
      const reply = await postChat(chat, { agent_id: agent, user_id: 'u-base', message, ...extra })
      if (reply.status !== 200) throw new Error(`/chat answered ${String(reply.status)}: ${JSON.stringify(reply.body)}`)
      const body = reply.body as ChatReplyBody
      const ended = (turns.get(body.session_id) ?? 0) + 1
      turns.set(body.session_id, ended)
      const records = await waitForSessionLog<BaseLogRecord>(home, body.session_id, log => log.filter(record => record.type === 'turn/end').length >= ended)
      return { body, records }
    },
  }
}

/** The row `lyteboat serve --plugin <file>` inserts for this package's plugin file `name` (under `fixtures/plugins`). */
export function fixturePluginRow(name: string): PatchOptions {
  return pluginFileRow(join(PLUGINS, name))
}

/** The question a model request answers: the first human message of its session, which these tests open one per question. */
export function questionOf(request: RecordedRequest): string {
  return request.body.messages.find(message => message.role === 'user')?.content.find(block => block.type === 'text')?.text ?? ''
}
