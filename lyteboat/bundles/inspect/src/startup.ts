/**
 * The inspect app's command-line provider. `lyteboat inspect --agents <dir>
 * --agent <id>` names the agent to mount and inspect; `--result json` prints
 * the finding as one JSON object instead of text. A bad flag or a missing
 * directory is a usage error (exit 2), so nothing is provided.
 * @module @lyteboat/inspect/startup
 */

import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { Command } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'

/** Service provided by this plugin and injected by the catalog and inspect rows. */
export const LYTEBOAT_INSPECT_STARTUP_SERVICE = 'lyteboatInspectStartup'

/** What the rows read from {@link LYTEBOAT_INSPECT_STARTUP_SERVICE}. */
export interface LyteboatInspectStartupValues {
  /** Absolute agent roots. */
  agentRoots: string[]
  agent: string
  result: 'text' | 'json'
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    lyteboatInspectStartup: LyteboatInspectStartupValues
  }
}

const collect = (value: string, previous: string[] = []): string[] => [...previous, value]

const USAGE = { exitCode: 2 }

function command(): Command {
  return new Command()
    .name('lyteboat inspect')
    .description('Mount one agent the way the business modes do and print what it is made of: its tools and how each reaches the model, its skills and their checks, its eval case files; or why it did not mount (exit 1).')
    .helpOption('-h, --help', 'show this help')
    .option('--agents <dir>', 'a directory of agents (repeatable, at least one)', collect)
    .option('--agent <id>', 'the agent to inspect')
    .option('--result <format>', 'text, or json (one object on stdout)', 'text')
    .addHelpText('after', `
Examples:
  lyteboat inspect --agents ./agents --agent finance                  what finance is made of
  lyteboat inspect --agents ./agents --agent finance --result json    the same as one JSON object
`)
}

export default class LyteboatInspectStartup {
  /** Services required before the invocation can be read. */
  static inject = ['cmdlineArgs']

  /**
   * Parse and provide the invocation.
   * @param ctx - plugin context carrying the command line.
   */
  constructor(ctx: Context) {
    const program = command()
    program.action(() => {
      const options = program.opts<{ agents?: string[]; agent?: string; result: string }>()
      const agentRoots = (options.agents ?? []).map(dir => resolve(dir))
      if (agentRoots.length === 0) program.error('error: at least one --agents directory is required', USAGE)
      for (const dir of agentRoots) {
        if (!existsSync(dir) || !statSync(dir).isDirectory()) program.error(`error: --agents directory not found: ${dir}`, USAGE)
      }
      const agent = options.agent ?? ''
      if (agent === '') program.error('error: --agent is required', USAGE)
      if (options.result !== 'text' && options.result !== 'json') program.error('error: --result must be text or json', USAGE)
      ctx.provide(LYTEBOAT_INSPECT_STARTUP_SERVICE, {
        agentRoots,
        agent,
        // program.error() exits, but TypeScript cannot narrow through it.
        result: options.result === 'json' ? 'json' : 'text',
      } satisfies LyteboatInspectStartupValues)
    })
    parseCmdline(ctx, program)
  }
}
