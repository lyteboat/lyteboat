/**
 * Commander adapter for the `lyteboat` command line.
 *
 * The launcher parses only what it owns — the subcommand, which profile to
 * boot, extra patch overlays, and the config dump — and hands everything after
 * its own flags to the booted tree verbatim, where the app plugins parse their
 * own flag families and print their own `--help` (see `@deepseek-ai/dsh-cmdline`).
 * Launcher flags therefore come first: the first token a subcommand does not
 * recognize starts the inner arguments, so `lyteboat serve --port 0` boots the
 * serve profile with `--port 0`, and `lyteboat headless -h` prints dsh's one-shot help.
 *
 * Adapted from deepseek-ai/deepseek-harness apps/cli/src/args.ts
 * @ dsh-v0.2.0-rc.2 (639ed015), MIT — see THIRD_PARTY_NOTICES.md.
 * @module @lyteboat/cli/args
 */

import { Command, CommanderError } from 'commander'
import { pluginFilesProblem } from './plugins.ts'
import { DEFAULT_EVAL_PROFILE, DEFAULT_HEADLESS_AGENT_PROFILE, DEFAULT_HEADLESS_PROFILE, DEFAULT_INSPECT_PROFILE, DEFAULT_SERVE_PROFILE, DEFAULT_STUDIO_PROFILE, DEFAULT_WEB_PROFILE } from './templates.ts'

/** Boot a named profile and hand it the invocation's inner arguments. */
interface ProfileInvocation {
  mode: 'profile'
  profile: string
  /** Extra patch-list overlays applied after the profile's own layer, in argv order. */
  patches: string[]
  /** Local plugin files inserted as rows, in argv order. */
  plugins: string[]
  /** Everything after the launcher's own flags, verbatim, for the app plugins. */
  args: string[]
}

/** Print a composed profile tree and exit without booting. */
interface DumpConfigInvocation {
  mode: 'dump-config'
  profile: string
  /** Omit the profile's user layer and --patch overlays; print bundle layers only. */
  defaultOnly: boolean
  patches: string[]
  plugins: string[]
}

/** The resolved `lyteboat` invocation. Help, version, and errors exit inside {@link parseLyteboatArgs}. */
type LyteboatInvocation = ProfileInvocation | DumpConfigInvocation

/** Versions printed by `lyteboat --version`. */
export interface LyteboatVersions {
  lyteboat: string
  dsh: string
}

interface BootOptions {
  profile?: string
  patch?: string[]
  plugin?: string[]
}

/** A subcommand that boots a profile: `lyteboat <name> [launcher flags] [inner arguments]`. */
interface LyteboatProfileCommand {
  name: string
  description: string
  /** The positional argument's syntax and description, for help. */
  argument: [string, string]
  /** The default `--profile`. */
  profile: string
  /** The default `--profile` instead when the inner arguments name an agent (`--agent`, `--agents`). */
  agentProfile?: string
  /** A command of the booted app the inner arguments go to (`lyteboat release …` is `eval release …`). */
  innerCommand?: string
  /** The help heading of the base the command boots. */
  helpGroup: string
}

/** Repeatable single-value collector; never variadic, which would swallow the inner arguments. */
const collect = (value: string, previous: string[] = []): string[] => [...previous, value]

const PATCH_OPTION_HELP = 'extra patch-list overlay applied after the profile layer (repeatable)'
const PLUGIN_OPTION_HELP = 'insert a local ESM plugin file as a row of the tree (repeatable)'

/** Help headings, one per base. */
const NATIVE_HELP_GROUP = 'Native dsh (dsh\'s own apps on lyteboat\'s kernel):'
const BUSINESS_HELP_GROUP = 'Business agents:'

const HELP_EXAMPLES = `
Examples:
  lyteboat web                                         serve dsh's web app: dsh's coding agent and personal assistant (lyteboat web --help)
  lyteboat headless "run the tests"                    answer one task with dsh's own agent, print the result, and exit
  lyteboat headless --agents ./agents --agent finance "task"  answer one task as an agent, print the turn, and exit
  lyteboat headless --agents ./agents --agent finance -h      the business one-shot's own flags and help
  lyteboat headless --patch ./extra.yml "task"         boot the headless profile with one extra overlay
  lyteboat headless --plugin ./my-plugin.mjs "task"    insert a local plugin file into the tree
  lyteboat serve --agents ./agents                     serve the agents over HTTP: POST /chat (lyteboat serve --help)
  lyteboat eval --agents ./agents --agent finance      run an agent's eval cases and check every turn (lyteboat eval --help)
  lyteboat release --agents ./agents --agent finance   check an agent against its baseline and write its release lock
  lyteboat serve --release ./agents/finance/agent.release.json  serve an agent exactly as released
  lyteboat inspect --agents ./agents --agent finance   print what an agent is made of, or why it does not mount
  lyteboat studio account add alice --role admin < pw.txt  make the first Studio account (password on stdin)
  lyteboat studio --agents ./agents                    serve the Studio workshop (lyteboat studio --help)
  lyteboat config dump --profile headless-agent        print the composed plugin tree and exit
`

function validateBoot(program: Command, options: BootOptions): { profile: string; patches: string[]; plugins: string[] } {
  const patches = options.patch ?? []
  if (patches.includes('')) program.error('error: --patch needs a path')
  const plugins = options.plugin ?? []
  if (plugins.includes('')) program.error('error: --plugin needs a path')
  const pluginProblem = pluginFilesProblem(plugins)
  if (pluginProblem !== undefined) program.error(`error: ${pluginProblem}`)
  if (options.profile === '') program.error('error: --profile needs a name')
  return { profile: options.profile ?? '', patches, plugins }
}

/** Whether inner arguments name an agent (`--agent`, `--agents`) before any `--`. */
function namesAgent(args: readonly string[]): boolean {
  for (const arg of args) {
    if (arg === '--') return false
    if (/^--agents?(?:=|$)/u.test(arg)) return true
  }
  return false
}

/** Configure a subcommand that hands its unknown tokens to the booted app. */
function passThrough(command: Command): Command {
  return command
    .helpOption(false)
    .allowUnknownOption()
    .passThroughOptions()
    .enablePositionalOptions()
}

/**
 * Resolve argv into one invocation, or print and exit for help, version, or an error.
 * @param argv - arguments after the Node binary and script.
 * @param versions - version strings printed by `--version`.
 * @returns the resolved invocation.
 */
export function parseLyteboatArgs(argv: readonly string[], versions: LyteboatVersions): LyteboatInvocation {
  let resolved: LyteboatInvocation | undefined
  const program: Command = new Command()
  program
    .name('lyteboat')
    .version(`lyteboat ${versions.lyteboat} (dsh ${versions.dsh})`, '-V, --version', 'output the version number')
    .description('lyteboat: DeepSeek Harness and more, on one kernel: dsh\'s own apps, and a base for business agents.')
    .addHelpText('after', HELP_EXAMPLES)
    .exitOverride()
    .enablePositionalOptions()

  // The subcommands that boot a profile, in help order.
  const profileCommands: LyteboatProfileCommand[] = [
    { name: 'web', description: `serve dsh's web app, as dsh ships it (profile: ${DEFAULT_WEB_PROFILE}); the web app's own flags follow`, argument: ['[args...]', 'arguments for the web app (see: lyteboat web --help)'], profile: DEFAULT_WEB_PROFILE, helpGroup: NATIVE_HELP_GROUP },
    { name: 'headless', description: `answer one task and exit: with dsh's own agent (profile: ${DEFAULT_HEADLESS_PROFILE}), or with --agent as a business agent (profile: ${DEFAULT_HEADLESS_AGENT_PROFILE}); the one-shot app's own flags follow`, argument: ['[task...]', 'the task text and any flags of the one-shot app (see: lyteboat headless --help, lyteboat headless --agent <id> --help)'], profile: DEFAULT_HEADLESS_PROFILE, agentProfile: DEFAULT_HEADLESS_AGENT_PROFILE, helpGroup: NATIVE_HELP_GROUP },
    { name: 'serve', description: `serve agents over HTTP (profile: ${DEFAULT_SERVE_PROFILE}); the service's own flags follow`, argument: ['[args...]', 'arguments for the service (see: lyteboat serve --help)'], profile: DEFAULT_SERVE_PROFILE, helpGroup: BUSINESS_HELP_GROUP },
    { name: 'eval', description: `run an agent's eval cases, replay a recorded run, or compare two runs (profile: ${DEFAULT_EVAL_PROFILE}); the eval app's own flags follow`, argument: ['[args...]', 'arguments for the eval app (see: lyteboat eval --help)'], profile: DEFAULT_EVAL_PROFILE, helpGroup: BUSINESS_HELP_GROUP },
    // A release is an eval run: the eval profile with the eval app's release command.
    { name: 'release', description: `put an agent through the release gate and write its release lock (profile: ${DEFAULT_EVAL_PROFILE}, as lyteboat eval release); the release command's own flags follow`, argument: ['[args...]', 'arguments for the release command (see: lyteboat release --help)'], profile: DEFAULT_EVAL_PROFILE, innerCommand: 'release', helpGroup: BUSINESS_HELP_GROUP },
    { name: 'studio', description: `serve the Studio workshop, or manage its accounts (profile: ${DEFAULT_STUDIO_PROFILE}); the Studio's own flags follow`, argument: ['[args...]', 'arguments for the Studio (see: lyteboat studio --help)'], profile: DEFAULT_STUDIO_PROFILE, helpGroup: BUSINESS_HELP_GROUP },
    { name: 'inspect', description: `mount one agent and print what it is made of: tools, skills and their checks, eval case files (profile: ${DEFAULT_INSPECT_PROFILE}); the inspect app's own flags follow`, argument: ['[args...]', 'arguments for the inspect app (see: lyteboat inspect --help)'], profile: DEFAULT_INSPECT_PROFILE, helpGroup: BUSINESS_HELP_GROUP },
  ]
  for (const spec of profileCommands) {
    const command: Command = passThrough(program.command(spec.name))
      .description(spec.description)
      .helpGroup(spec.helpGroup)
      .argument(...spec.argument)
      .option('--profile <name>', 'the profile under $LYTEBOAT_HOME/profiles to boot', spec.profile)
      .option('--patch <path>', PATCH_OPTION_HELP, collect)
      .option('--plugin <file>', PLUGIN_OPTION_HELP, collect)
      .action((args: string[], options: BootOptions) => {
        const booted = validateBoot(command, options)
        const { patches, plugins } = booted
        const profile = spec.agentProfile !== undefined && command.getOptionValueSource('profile') === 'default' && namesAgent(args) ? spec.agentProfile : booted.profile
        resolved = { mode: 'profile', profile, patches, plugins, args: spec.innerCommand === undefined ? args : [spec.innerCommand, ...args] }
      })
  }

  const config = program.command('config').description('inspect profile composition without booting')
  const dump = config.command('dump')
    .description('print the composed profile tree and exit')
    .option('--profile <name>', 'the profile to compose', DEFAULT_HEADLESS_AGENT_PROFILE)
    .option('--default', 'print the bundle layers only, without the user layer or --patch overlays')
    .option('--patch <path>', PATCH_OPTION_HELP, collect)
    .option('--plugin <file>', PLUGIN_OPTION_HELP, collect)
    .action((options: BootOptions & { default?: boolean }) => {
      const { profile, patches, plugins } = validateBoot(dump, options)
      const defaultOnly = options.default === true
      if (defaultOnly && (patches.length > 0 || plugins.length > 0)) dump.error('error: --default prints the bundle layers and takes no --patch or --plugin')
      resolved = { mode: 'dump-config', profile, defaultOnly, patches, plugins }
    })

  try {
    program.parse(argv, { from: 'user' })
  } catch (error) {
    return process.exit(error instanceof CommanderError ? error.exitCode : 1)
  }
  if (resolved === undefined) {
    program.outputHelp()
    return process.exit(1)
  }
  return resolved
}
