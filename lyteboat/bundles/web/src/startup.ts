/**
 * lyteboat web's command-line provider. dsh web's own startup row parses only the
 * web flags, and an unknown flag is a usage error there, so the web bundle
 * disables that row and this one parses the web flags (`--host`, `--no-open`,
 * `--port`, `--trusted-host`, with dsh web's rules), `--agents`, and
 * `--agent`. It publishes `webStartup` in dsh web's shape, which dsh web's
 * rows read, and {@link LYTEBOAT_WEB_STARTUP_SERVICE}, which the agent
 * catalog and the preset registry read.
 * @module @lyteboat/web/startup
 */

import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { Command } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'
import { agentIds } from '@lyteboat/agent-catalog'

/** Service provided by this plugin and injected by the agent catalog and preset registry rows. */
export const LYTEBOAT_WEB_STARTUP_SERVICE = 'lyteboatWebStartup'

/** What the rows read from {@link LYTEBOAT_WEB_STARTUP_SERVICE}. */
export interface LyteboatWebStartupValues {
  /** Absolute agent roots; none is dsh web with lyteboat's pages and no agent. */
  agentRoots: string[]
  /** The agent a new session runs unless another is picked; `none` when the roots hold none. */
  defaultAgent: string
}

/** dsh web's startup values (`@deepseek-ai/dsh-web-app/startup`), which dsh web's rows read. */
interface DshWebStartupValues {
  openBrowser: boolean
  host?: string
  port?: number
  trustedHosts: string[]
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    lyteboatWebStartup: LyteboatWebStartupValues
  }
}

const collect = (value: string, previous: string[] = []): string[] => [...previous, value]

function command(): Command {
  return new Command()
    .name('lyteboat web')
    .description('Serve dsh web with lyteboat\'s pages: the agents of the --agents directories, a message sent with its request context and the session\'s lyteboat state, the eval reports.')
    .helpOption('-h, --help', 'show this help')
    .option('--agents <dir>', 'a directory of agents to offer (repeatable); a change under it reloads the agents', collect)
    .option('--agent <id>', 'the agent a new session runs unless another is picked (default: the first of the directories by id)')
    .option('--host <host>', 'bind host')
    .option('--no-open', 'do not open the browser')
    .option('--port <port>', 'listen port; pass 0 to let the OS pick a free one')
    .option('--trusted-host <authority...>', 'extra authority the /api browser-trust fence accepts (host or host:port; repeatable)')
    .addHelpText('after', `
Examples:
  lyteboat web --agents ./agents               serve on the composed host and port and open the browser
  lyteboat web --agents ./agents --no-open --port 8080
  lyteboat web --agents ./agents --agent finance   new sessions run finance unless another agent is picked
`)
}

export default class LyteboatWebStartup {
  /** Services required before the invocation can be read. */
  static inject = ['cmdlineArgs']

  /**
   * Parse and provide the invocation. A missing agent root, an `--agent` no
   * root holds, `--host 0.0.0.0`, or a non-numeric port is a usage error, so
   * nothing is provided.
   * @param ctx - plugin context carrying the command line.
   */
  constructor(ctx: Context) {
    const program = command()
    program.action(() => {
      const options = program.opts<{ agents?: string[]; agent?: string; host?: string; open: boolean; port?: string; trustedHost?: string[] }>()
      const agentRoots = (options.agents ?? []).map(dir => resolve(dir))
      for (const dir of agentRoots) {
        if (!existsSync(dir) || !statSync(dir).isDirectory()) program.error(`error: --agents directory not found: ${dir}`)
      }
      const ids = agentIds(agentRoots)
      if (options.agent !== undefined && !ids.includes(options.agent)) program.error(`error: no --agents directory holds agent "${options.agent}" (available: ${ids.join(', ') || 'none'})`)
      // dsh web creates a new session under the registry's default, which must name a declared agent.
      const defaultAgent = options.agent ?? ids[0] ?? 'none'
      // dsh web's own rule: the browser UI runs code on this machine, so it never binds every interface.
      if (options.host === '0.0.0.0') program.error('error: --host 0.0.0.0 is not supported: the browser UI would expose code execution to the network; use 127.0.0.1')
      if (options.port !== undefined && !/^\d+$/u.test(options.port)) program.error(`error: --port must be a number, got ${JSON.stringify(options.port)}`)
      ctx.provide('webStartup', {
        openBrowser: options.open,
        ...options.host === undefined ? {} : { host: options.host },
        ...options.port === undefined ? {} : { port: Number(options.port) },
        trustedHosts: options.trustedHost ?? [],
      } satisfies DshWebStartupValues)
      ctx.provide(LYTEBOAT_WEB_STARTUP_SERVICE, { agentRoots, defaultAgent } satisfies LyteboatWebStartupValues)
    })
    parseCmdline(ctx, program)
  }
}
