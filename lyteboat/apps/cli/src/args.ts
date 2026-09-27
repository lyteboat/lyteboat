/**
 * Commander adapter for the `lyteboat` command line.
 *
 * The launcher parses only what it owns — the subcommand, which profile to
 * boot, extra patch overlays, and the config dump — and hands everything after
 * its own flags to the booted tree verbatim, where the app plugins parse their
 * own flag families and print their own `--help` (see `@deepseek-ai/dsh-cmdline`).
 * Launcher flags therefore come first: the first token a subcommand does not
 * recognize starts the inner arguments, so `lyteboat web --port 0` boots the
 * web profile with `--port 0`, and `lyteboat try -h` prints the one-shot app's help.
 *
 * Adapted from deepseek-ai/deepseek-harness apps/cli/src/args.ts
 * @ dsh-v0.1.7-rc.2 (477b4f42), MIT — see THIRD_PARTY_NOTICES.md.
 * @module @lyteboat/cli/args
 */

import { Command, CommanderError } from 'commander'
import { pluginFilesProblem } from './plugins.ts'
import { DEFAULT_EVAL_PROFILE, DEFAULT_INSPECT_PROFILE, DEFAULT_TRY_PROFILE, DEFAULT_SERVE_PROFILE, DEFAULT_STUDIO_PROFILE, DEFAULT_WEB_PROFILE } from './templates.ts'

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
  /** A command of the booted app the inner arguments go to (`lyteboat release …` is `eval release …`). */
  innerCommand?: string
}

/** Repeatable single-value collector; never variadic, which would swallow the inner arguments. */
const collect = (value: string, previous: string[] = []): string[] => [...previous, value]

const PATCH_OPTION_HELP = 'extra patch-list overlay applied after the profile layer (repeatable)'
const PLUGIN_OPTION_HELP = 'insert a local ESM plugin file as a row of the tree (repeatable)'

const HELP_EXAMPLES = `
Examples:
  lyteboat try --agents ./agents --agent finance "task"  answer one task as an agent, print the result, and exit
  lyteboat try --patch ./extra.yml "task"              boot the try profile with one extra overlay
  lyteboat try --plugin ./my-plugin.mjs "task"         insert a local plugin file into the tree
  lyteboat try -h                                      the one-shot app's own flags and help
  lyteboat web --agents ./agents                       serve dsh web with lyteboat's pages (lyteboat web --help)
  lyteboat web --agents ./agents --no-open --port 8080     without opening a browser, on another port
  lyteboat serve --agents ./agents                     serve the agents over HTTP: POST /chat (lyteboat serve --help)
  lyteboat eval --agents ./agents --agent finance      run an agent's eval cases and check every turn (lyteboat eval --help)
  lyteboat release --agents ./agents --agent finance   check an agent against its baseline and write its release lock
  lyteboat serve --release ./agents/finance/agent.release.json  serve an agent exactly as released
  lyteboat inspect --agents ./agents --agent finance   print what an agent is made of, or why it does not mount
  lyteboat studio account add alice --role admin < pw.txt  make the first Studio account (password on stdin)
  lyteboat studio --agents ./agents                    serve the Studio workshop (lyteboat studio --help)
  lyteboat config dump --profile try                   print the composed plugin tree and exit
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
    .description('lyteboat: an agent harness composed from DeepSeek Harness bundles under your own overrides.')
    .addHelpText('after', HELP_EXAMPLES)
    .exitOverride()
    .enablePositionalOptions()

  // The subcommands that boot a profile, in help order.
  const profileCommands: LyteboatProfileCommand[] = [
    { name: 'try', description: `answer one task and exit (profile: ${DEFAULT_TRY_PROFILE})`, argument: ['[task...]', 'the task text and any flags of the one-shot app'], profile: DEFAULT_TRY_PROFILE },
    { name: 'web', description: `serve dsh web with lyteboat's pages (profile: ${DEFAULT_WEB_PROFILE}); dsh web's own flags follow`, argument: ['[args...]', 'arguments for dsh web (see: lyteboat web --help)'], profile: DEFAULT_WEB_PROFILE },
    { name: 'serve', description: `serve agents over HTTP (profile: ${DEFAULT_SERVE_PROFILE}); the service's own flags follow`, argument: ['[args...]', 'arguments for the service (see: lyteboat serve --help)'], profile: DEFAULT_SERVE_PROFILE },
    { name: 'eval', description: `run an agent's eval cases, replay a recorded run, or compare two runs (profile: ${DEFAULT_EVAL_PROFILE}); the eval app's own flags follow`, argument: ['[args...]', 'arguments for the eval app (see: lyteboat eval --help)'], profile: DEFAULT_EVAL_PROFILE },
    // A release is an eval run: the eval profile with the eval app's release command.
    { name: 'release', description: `put an agent through the release gate and write its release lock (profile: ${DEFAULT_EVAL_PROFILE}, as lyteboat eval release); the release command's own flags follow`, argument: ['[args...]', 'arguments for the release command (see: lyteboat release --help)'], profile: DEFAULT_EVAL_PROFILE, innerCommand: 'release' },
    { name: 'studio', description: `serve the Studio workshop, or manage its accounts (profile: ${DEFAULT_STUDIO_PROFILE}); the Studio's own flags follow`, argument: ['[args...]', 'arguments for the Studio (see: lyteboat studio --help)'], profile: DEFAULT_STUDIO_PROFILE },
    { name: 'inspect', description: `mount one agent and print what it is made of: tools, skills and their checks, eval case files (profile: ${DEFAULT_INSPECT_PROFILE}); the inspect app's own flags follow`, argument: ['[args...]', 'arguments for the inspect app (see: lyteboat inspect --help)'], profile: DEFAULT_INSPECT_PROFILE },
  ]
  for (const spec of profileCommands) {
    const command: Command = passThrough(program.command(spec.name))
      .description(spec.description)
      .argument(...spec.argument)
      .option('--profile <name>', 'the profile under $LYTEBOAT_HOME/profiles to boot', spec.profile)
      .option('--patch <path>', PATCH_OPTION_HELP, collect)
      .option('--plugin <file>', PLUGIN_OPTION_HELP, collect)
      .action((args: string[], options: BootOptions) => {
        const { profile, patches, plugins } = validateBoot(command, options)
        resolved = { mode: 'profile', profile, patches, plugins, args: spec.innerCommand === undefined ? args : [spec.innerCommand, ...args] }
      })
  }

  const config = program.command('config').description('inspect profile composition without booting')
  const dump = config.command('dump')
    .description('print the composed profile tree and exit')
    .option('--profile <name>', 'the profile to compose', DEFAULT_TRY_PROFILE)
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
