/**
 * The service app's command-line provider: it parses `--agents` or
 * `--release`, `--host`, `--port`, `--auth`, and `--secret-env`, checks them,
 * and publishes {@link LYTEBOAT_SERVE_STARTUP_SERVICE}, which the agent
 * catalog, web server, and chat-api rows read from lazy config. A release
 * lock (`lyteboat release` writes it) lies in its agent's directory; serving
 * it declares that agent alone, pinned to what the lock says. The lock's dsh
 * release is checked here, before any row that reads the invocation starts,
 * so `/chat` never opens for an agent released on another kernel.
 * @module @lyteboat/serve/startup
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { Command } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'
import type { AgentCatalogPin } from '@lyteboat/agent-catalog'
import { lyteboatAgentReleaseSchema, type LyteboatAgentRelease } from '@lyteboat/contracts'

/** Service provided by this plugin and injected by the catalog, web server, and chat-api rows. */
export const LYTEBOAT_SERVE_STARTUP_SERVICE = 'lyteboatServeStartup'

/** What the rows read from {@link LYTEBOAT_SERVE_STARTUP_SERVICE}. */
export interface LyteboatServeStartupValues {
  /** Absolute agent roots. */
  agentRoots: string[]
  /** The agents served: the released ones; empty serves every agent the roots hold. */
  include: string[]
  /** What each released agent must be, by id; empty without `--release`. */
  pinnedAgents: Record<string, AgentCatalogPin>
  /** The listen host: loopback, or every interface. */
  host: '127.0.0.1' | '0.0.0.0'
  /** The listen port; 0 asks the OS for one. */
  port: number
  /** How `/chat` authenticates callers. */
  auth: 'none' | 'shared-secret'
  /** The environment variable that holds the shared secret. */
  credentialRef: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    lyteboatServeStartup: LyteboatServeStartupValues
  }
}

const collect = (value: string, previous: string[] = []): string[] => [...previous, value]

/**
 * A release lock and its agent directory. A lock that cannot be read, lies
 * outside its agent's directory, or was released on another dsh is a usage error.
 */
function readReleaseLock(program: Command, file: string, dshBase: string): { dir: string; release: LyteboatAgentRelease } {
  const path = resolve(file)
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error: unknown) {
    return program.error(`error: --release ${path} cannot be read: ${error instanceof Error ? error.message : String(error)}`)
  }
  const parsed = lyteboatAgentReleaseSchema.safeParse(raw)
  if (!parsed.success) return program.error(`error: --release ${path} is not a release lock: ${parsed.error.issues.map(issue => `${issue.path.join('.') || '(the file)'}: ${issue.message}`).join('; ')}`)
  const release = parsed.data
  const dir = dirname(path)
  if (basename(dir) !== release.agent.id) program.error(`error: --release ${path} releases ${release.agent.id}, but lies in ${dir}; a lock stays in its agent's directory`)
  if (release.dshBase !== dshBase) program.error(`error: --release ${path} was released on dsh ${release.dshBase}, but this build runs dsh ${dshBase}; release the agent again with this build`)
  return { dir, release }
}

function command(): Command {
  return new Command()
    .name('lyteboat serve')
    .description('Serve the agents of the --agents directories, or the agents of --release locks, over HTTP: POST /chat, GET /agents, GET /health.')
    .helpOption('-h, --help', 'show this help')
    .option('--agents <dir>', 'a directory of agents to serve (repeatable)', collect)
    .option('--release <file>', 'an agent\'s release lock, <agent>/agent.release.json: serve that agent, pinned to the lock (repeatable; not with --agents)', collect)
    .option('--host <host>', 'listen on 127.0.0.1 (the default) or 0.0.0.0', '127.0.0.1')
    .option('--port <port>', 'listen port; 0 picks a free one', '8080')
    .option('--auth <mode>', 'none (only on 127.0.0.1) or shared-secret (Authorization: Bearer <secret>)', 'none')
    .option('--secret-env <name>', 'the environment variable that holds the shared secret', 'LYTEBOAT_CHAT_SECRET')
    .addHelpText('after', `
Examples:
  lyteboat serve --agents ./agents                              serve on http://127.0.0.1:8080 without auth
  lyteboat serve --release ./agents/finance/agent.release.json  serve finance exactly as released
  LYTEBOAT_CHAT_SECRET=… lyteboat serve --agents ./agents --host 0.0.0.0 --auth shared-secret
                                                                 serve on every interface behind a bearer token
`)
}

export default class LyteboatServeStartup {
  /** Services required before the invocation can be read. */
  static inject = ['cmdlineArgs', 'lyteboatDistro']

  /**
   * Parse and provide the invocation. A missing or unknown agent root, a lock
   * that cannot be served, both `--agents` and `--release`, a host other than
   * the two, a bad port, or `--auth none` on every interface is a usage error,
   * so nothing is provided.
   * @param ctx - plugin context carrying the command line and this build's dsh release.
   */
  constructor(ctx: Context) {
    const program = command()
    program.action(() => {
      const options = program.opts<{ agents?: string[]; release?: string[]; host: string; port: string; auth: string; secretEnv: string }>()
      const releaseFiles = options.release ?? []
      if (releaseFiles.length > 0 && options.agents !== undefined) program.error('error: --release and --agents are exclusive: serve released agents, or every agent of the directories')
      const releases = releaseFiles.map(file => readReleaseLock(program, file, ctx.lyteboatDistro.dsh))
      const include = releases.map(({ release }) => release.agent.id)
      const twice = include.find((id, index) => include.indexOf(id) !== index)
      if (twice !== undefined) program.error(`error: --release names agent ${twice} twice`)
      const agentRoots = releases.length > 0 ? [...new Set(releases.map(({ dir }) => dirname(dir)))] : (options.agents ?? []).map(dir => resolve(dir))
      if (agentRoots.length === 0) program.error('error: at least one --agents directory or --release lock is required')
      for (const dir of agentRoots) {
        if (!existsSync(dir) || !statSync(dir).isDirectory()) program.error(`error: --agents directory not found: ${dir}`)
      }
      const pinnedAgents = Object.fromEntries(releases.map(({ release: { agent, files } }) => [agent.id, { version: agent.version, digest: agent.digest, files }]))
      if (options.host !== '127.0.0.1' && options.host !== '0.0.0.0') program.error('error: --host must be 127.0.0.1 or 0.0.0.0')
      const port = Number(options.port)
      if (!Number.isInteger(port) || port < 0 || port > 65_535) program.error(`error: --port must be an integer from 0 to 65535, not ${options.port}`)
      if (options.auth !== 'none' && options.auth !== 'shared-secret') program.error('error: --auth must be none or shared-secret')
      if (options.auth === 'none' && options.host !== '127.0.0.1') program.error('error: --auth none serves only 127.0.0.1; use --auth shared-secret with --host 0.0.0.0')
      // program.error() exits, but TypeScript cannot narrow through it.
      const host = options.host === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1'
      const auth = options.auth === 'shared-secret' ? 'shared-secret' : 'none'
      ctx.provide(LYTEBOAT_SERVE_STARTUP_SERVICE, {
        agentRoots,
        include,
        pinnedAgents,
        host,
        port,
        auth,
        credentialRef: options.secretEnv,
      } satisfies LyteboatServeStartupValues)
    })
    parseCmdline(ctx, program)
  }
}
