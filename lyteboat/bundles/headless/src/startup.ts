/**
 * The business one-shot's command-line provider, in place of dsh-headless's
 * `headless-startup` row: it parses dsh's one-shot flags (the task, `-` for
 * stdin, `--session-id`, `--json`) and lyteboat's (`--agent`, `--agents`,
 * `--history`, `--context`, `--result`), checks that an `--agents` root holds
 * the agent, then publishes {@link LYTEBOAT_HEADLESS_STARTUP_SERVICE}. The agent
 * catalog, preset registry, and `@lyteboat/headless` rows inject it; the last
 * passes dsh's part on to the runner.
 *
 * Modeled on deepseek-ai/deepseek-harness packages/bundle/headless/src/startup.ts
 * @ dsh-v0.2.0-rc.2 (639ed015), MIT — see THIRD_PARTY_NOTICES.md. Differences:
 * the agent, agent-root, history, context, and result flags, resolved and
 * checked here.
 * @module @lyteboat/headless/startup
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { Command, CommanderError } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'
import type { JsonValue } from '@lyteboat/contracts'
import { agentIds } from '@lyteboat/agent-catalog'

/** Service provided by this plugin and injected by the agent catalog, preset registry, and `@lyteboat/headless` rows. */
export const LYTEBOAT_HEADLESS_STARTUP_SERVICE = 'lyteboatHeadlessStartup'

/** What the rows read from {@link LYTEBOAT_HEADLESS_STARTUP_SERVICE}. */
export interface LyteboatHeadlessStartupValues {
  /** The task text; absent when the runner reads it from stdin. */
  task: string | undefined
  /** A stored session to continue instead of starting a new one. */
  sessionId: string | undefined
  /** Whether stdout carries dsh's event stream instead of the turn. */
  json: boolean
  /** The agent to compose from (its agent preset id, `--agent`); absent runs the business base alone. */
  agent: string | undefined
  /** Absolute `--agents` roots the agent catalog declares `agent` from; empty without `--agent`. */
  agentRoots: string[]
  /** Absolute path of an external history file to seed the session from. */
  history: string | undefined
  /** The request context this task carries; absent keeps a continued session's earlier context. */
  context: { [key: string]: JsonValue } | undefined
  /** How the turn is printed: the answer as text, or one `LyteboatHeadlessResult` object. */
  result: 'text' | 'json'
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    lyteboatHeadlessStartup: LyteboatHeadlessStartupValues
  }
}

const collect = (value: string, previous: string[] = []): string[] => [...previous, value]

/** The options whose next argument is their value, so a `--json` there is not the flag. */
const VALUE_OPTIONS = new Set(['--agent', '--agents', '--history', '--session-id', '--context', '--result'])

/**
 * Whether the raw invocation asks for dsh's event stream. The scan stops at `--`
 * and skips option values, so a literal `--json` used as a value or a task word
 * never turns usage errors into events.
 */
function jsonRequested(argv: readonly string[]): boolean {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? ''
    if (argument === '--') return false
    if (argument === '--json') return true
    if (VALUE_OPTIONS.has(argument)) index += 1
  }
  return false
}

/**
 * The request context a `--context` value names: a JSON object written inline
 * (it starts with `{`) or held in a file.
 * @returns the object, or why it is not one.
 */
function readContext(value: string): { kind: 'context'; context: { [key: string]: JsonValue } } | { kind: 'problem'; problem: string } {
  const inline = value.trimStart().startsWith('{')
  const path = resolve(value)
  if (!inline && !existsSync(path)) return { kind: 'problem', problem: `--context file not found: ${path}` }
  let parsed: unknown
  try {
    parsed = JSON.parse(inline ? value : readFileSync(path, 'utf8'))
  } catch (error: unknown) {
    return { kind: 'problem', problem: `--context is not JSON: ${error instanceof Error ? error.message : String(error)}` }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { kind: 'problem', problem: '--context must be a JSON object' }
  // JSON.parse yields JSON: the cast only names it.
  return { kind: 'context', context: parsed as { [key: string]: JsonValue } }
}

function command(): Command {
  return new Command()
    .name('lyteboat headless --agent <id>')
    .description('Answer one task as an agent and exit; the turn goes to stdout and diagnostics to stderr.')
    .helpOption('-h, --help', 'show this help')
    .argument('[task...]', 'the task text; multiple words are joined by spaces, and `-` reads stdin')
    .option('--agent <id>', 'run this agent from the --agents directories')
    .option('--agents <dir>', 'a directory of agents (repeatable)', collect)
    .option('--history <file>', 'seed a new session from an external history file')
    .option('--session-id <id>', 'continue the stored session with this id (every run prints its id: on stderr, or with --json in the session event)')
    .option('--context <json>', 'the request context: a JSON object, inline or in a file; logged with the request, read by tools, not shown to the model (an empty one keeps the session\'s)')
    .option('--result <format>', 'text (the answer, each card as a [card <area>] line), or json (the turn as one object: outcome, text, cards, tools, skill, model, session id)', 'text')
    .option('--json', 'write dsh\'s newline-delimited run events to stdout instead of the turn')
    .addHelpText('after', `
Examples:
  lyteboat headless --agents ./agents --agent <id> --context '{"key":"value"}' "<task>"
                                                            run an agent from ./agents with a request context
  lyteboat headless --agents ./agents --agent <id> --session-id session-… "<task>"
                                                            continue that session
`)
}

export default class LyteboatHeadlessStartup {
  /** Services required before the task can be resolved. */
  static inject = ['cmdlineArgs']

  /**
   * Parse and provide the one-shot invocation as an ordinary Cordis service. A
   * missing task, an unknown directory, an agent without roots, or an agent no
   * root holds is a usage error, so on rejection (and on `--help`) nothing is provided.
   * @param ctx - plugin context carrying the command line.
   */
  constructor(ctx: Context) {
    const program = command()
    // Commander rejects a grammar error before the action runs, and a `--json` caller is
    // still owed it as an event: dsh's JSON contract keeps stdout to events and stderr
    // to the runner's `dsh:` lines.
    if (jsonRequested(ctx.get('cmdlineArgs')?.get() ?? [])) {
      program.error = (message: string, errorOptions?: Parameters<Command['error']>[1]): never => {
        process.stdout.write(`${JSON.stringify({ type: 'error', message: message.replace(/^error: /u, '') })}\n`)
        throw new CommanderError(1, errorOptions?.code ?? 'commander.error', message)
      }
    }
    program.action(() => {
      const options = program.opts<{ agent?: string; agents?: string[]; history?: string; sessionId?: string; context?: string; result: string; json?: boolean }>()
      if (program.args.length > 1 && program.args.includes('-')) program.error('error: `-` must be the only task argument')
      const joined = program.args.join(' ')
      const task = program.args.length === 0 ? undefined : joined
      // dsh's one-shot reads stdin when no task is given, so only a terminal stdin lacks one.
      if (task === undefined ? process.stdin.isTTY : joined.trim() === '') program.error('error: a task is required, for example: lyteboat headless --agents ./agents --agent <id> "<task>"')
      const agentRoots = (options.agents ?? []).map(dir => resolve(dir))
      for (const dir of agentRoots) {
        if (!existsSync(dir) || !statSync(dir).isDirectory()) program.error(`error: --agents directory not found: ${dir}`)
      }
      const agent = options.agent
      if (agent !== undefined && agentRoots.length === 0) program.error('error: --agent needs at least one --agents directory')
      if (agentRoots.length > 0 && agent === undefined) program.error('error: --agents needs --agent to choose the agent')
      if (agent !== undefined && !agentIds(agentRoots).includes(agent)) {
        program.error(`error: agent ${JSON.stringify(agent)} not found in the --agents directories (available: ${agentIds(agentRoots).join(', ') || 'none'})`)
      }
      const history = options.history === undefined ? undefined : resolve(options.history)
      if (history !== undefined && !existsSync(history)) program.error(`error: --history file not found: ${history}`)
      const sessionId = options.sessionId
      if (sessionId !== undefined && sessionId.trim() === '') program.error('error: --session-id needs a session id')
      if (sessionId !== undefined && history !== undefined) program.error('error: --history seeds a new session; it cannot be combined with --session-id')
      const read = options.context === undefined ? undefined : readContext(options.context)
      if (read?.kind === 'problem') program.error(`error: ${read.problem}`)
      if (options.result !== 'text' && options.result !== 'json') program.error('error: --result must be text or json')
      if (options.json === true && options.result === 'json') program.error('error: --json streams run events; it cannot be combined with --result json')
      ctx.provide(LYTEBOAT_HEADLESS_STARTUP_SERVICE, {
        task,
        sessionId,
        json: options.json === true,
        agent,
        agentRoots,
        history,
        context: read?.kind === 'context' ? read.context : undefined,
        // program.error() exits, but TypeScript cannot narrow through it.
        result: options.result === 'json' ? 'json' : 'text',
      } satisfies LyteboatHeadlessStartupValues)
    })
    parseCmdline(ctx, program)
  }
}
