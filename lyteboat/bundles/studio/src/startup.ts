/**
 * The Studio's command-line provider. `lyteboat studio --agents <dir>` serves
 * the workshop (`--host`, `--port`, `--trusted-host`, `--gateway-secret-env`
 * with `--admin`, `--anonymous-viewer`, `--trace-link`) and publishes
 * {@link LYTEBOAT_STUDIO_STARTUP_SERVICE}, which the catalog, web server,
 * studio-auth, and studio-api rows read from lazy config. In internal mode
 * people sign in with accounts an operator made; a Studio without any is a
 * usage error that names the command. `lyteboat studio account add | set-password
 * | remove | list` manages them: it reads a password from stdin (never a flag,
 * so it stays out of the shell history and the process list), does its one
 * change, and exits before any row listens.
 * @module @lyteboat/studio/startup
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { Command } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-app-boot'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { STUDIO_ROLES, type StudioRole } from '@lyteboat/contracts/studio'
import { readStudioAccounts, readStudioGrants, removeStudioAccount, setStudioAccount, setStudioGrant } from '@lyteboat/studio-auth/accounts'

/** Service provided by this plugin and injected by the catalog, web server, studio-auth, and studio-api rows. */
export const LYTEBOAT_STUDIO_STARTUP_SERVICE = 'lyteboatStudioStartup'

/** What the rows read from {@link LYTEBOAT_STUDIO_STARTUP_SERVICE}. */
export interface LyteboatStudioStartupValues {
  /** Absolute agent roots. */
  agentRoots: string[]
  host: '127.0.0.1' | '0.0.0.0'
  /** The listen port; 0 asks the OS for one. */
  port: number
  /** Host header values accepted beside the loopback names. */
  trustedHosts: string[]
  /** Gateway mode: the environment variable holding the gateway's shared secret. */
  gateway?: { secretRef: string }
  /** User ids made admins at startup (gateway mode). */
  admins: string[]
  anonymousViewer: boolean
  traceLinkTemplate?: string
  /** Variables the System page masks whatever their names. */
  maskedEnv: string[]
  /** The launcher's version, when a launcher booted this Studio. */
  lyteboatVersion?: string
  /** The launcher's bin, which the Studio's eval runs start; absent when no launcher booted this Studio. */
  lyteboatBin?: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    lyteboatStudioStartup: LyteboatStudioStartupValues
  }
}

interface StudioServeOptions {
  agents?: string[]
  host: string
  port: string
  trustedHost?: string[]
  gatewaySecretEnv?: string
  admin?: string[]
  anonymousViewer?: boolean
  traceLink?: string
}

const collect = (value: string, previous: string[] = []): string[] => [...previous, value]

const ACCOUNT_HINT = 'lyteboat studio account add <username> --role admin < password-file'

function command(): Command {
  return new Command()
    .name('lyteboat studio')
    .description('Serve the Studio workshop for the agents of the --agents directories: sign-in and roles, the agent radar, the System page; Studio inspects agents and never runs a session.')
    .helpOption('-h, --help', 'show this help')
    .enablePositionalOptions()
    .option('--agents <dir>', 'a directory of agents to inspect (repeatable); a change under it reloads the agents', collect)
    .option('--host <host>', 'listen on 127.0.0.1 (the default) or 0.0.0.0', '127.0.0.1')
    .option('--port <port>', 'listen port; 0 picks a free one', '8090')
    .option('--trusted-host <name>', 'a Host header name (or name:port) people reach this Studio by, beside the loopback names (repeatable; required with --host 0.0.0.0)', collect)
    .option('--gateway-secret-env <name>', 'gateway mode: an authorizing gateway sends this variable\'s value and the user\'s id on every request')
    .option('--admin <user-id>', 'gateway mode: make this user id an admin at startup (repeatable)', collect)
    .option('--anonymous-viewer', 'internal mode: a request without a token reads as an anonymous viewer (only on 127.0.0.1)')
    .option('--trace-link <url>', 'the tracing UI\'s URL for one trace, with {trace_id} where the id goes')
    .addHelpText('after', `
Accounts (internal mode; the password is read from stdin, one line):
  lyteboat studio account add <username> --role <admin|editor|viewer> [--display-name <name>] [--user-id <id>]
  lyteboat studio account set-password <username>
  lyteboat studio account remove <username>
  lyteboat studio account list

Examples:
  ${ACCOUNT_HINT}
  lyteboat studio --agents ./agents                          serve on http://127.0.0.1:8090
  STUDIO_GATEWAY_SECRET=… lyteboat studio --agents ./agents --host 0.0.0.0 --trusted-host studio.example \\
      --gateway-secret-env STUDIO_GATEWAY_SECRET --admin alice    behind an authorizing gateway
`)
}

/** Check the serve flags and build the values; a bad one is a usage error. */
function studioValuesOf(program: Command, options: StudioServeOptions, launcher: StudioLauncher): LyteboatStudioStartupValues {
  const agentRoots = (options.agents ?? []).map(dir => resolve(dir))
  if (agentRoots.length === 0) program.error('error: at least one --agents directory is required')
  for (const dir of agentRoots) {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) program.error(`error: --agents directory not found: ${dir}`)
  }
  if (options.host !== '127.0.0.1' && options.host !== '0.0.0.0') program.error('error: --host must be 127.0.0.1 or 0.0.0.0')
  const port = Number(options.port)
  if (!Number.isInteger(port) || port < 0 || port > 65_535) program.error(`error: --port must be an integer from 0 to 65535, not ${options.port}`)
  const trustedHosts = options.trustedHost ?? []
  if (options.host === '0.0.0.0' && trustedHosts.length === 0) program.error('error: --host 0.0.0.0 needs --trusted-host for each name people reach this Studio by; any other Host header is refused')
  const secretRef = options.gatewaySecretEnv
  if (secretRef !== undefined && (process.env[secretRef] ?? '') === '') program.error(`error: --gateway-secret-env names ${secretRef}, which is not set`)
  if (secretRef === undefined && options.admin !== undefined) program.error(`error: --admin is for gateway mode; give an account its role with: ${ACCOUNT_HINT}`)
  if (options.anonymousViewer === true && secretRef !== undefined) program.error('error: --anonymous-viewer is for internal mode; a gateway authenticates every request')
  if (options.anonymousViewer === true && options.host !== '127.0.0.1') program.error('error: --anonymous-viewer serves only 127.0.0.1')
  if (options.traceLink !== undefined && !options.traceLink.includes('{trace_id}')) program.error('error: --trace-link must hold {trace_id}, where a session\'s trace id goes')
  if (secretRef === undefined && Object.keys(readStudioAccounts(dshHomePath('studio'))).length === 0) {
    program.error(`error: this Studio has no accounts to sign in with; make the first one with: ${ACCOUNT_HINT}`)
  }
  return {
    agentRoots,
    // program.error() exits, but TypeScript cannot narrow through it.
    host: options.host === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1',
    port,
    trustedHosts,
    ...secretRef === undefined ? {} : { gateway: { secretRef } },
    admins: options.admin ?? [],
    anonymousViewer: options.anonymousViewer === true,
    ...options.traceLink === undefined ? {} : { traceLinkTemplate: options.traceLink },
    maskedEnv: secretRef === undefined ? [] : [secretRef],
    ...launcher.version === undefined ? {} : { lyteboatVersion: launcher.version },
    ...launcher.bin === undefined ? {} : { lyteboatBin: launcher.bin },
  }
}

/** The launcher that booted this Studio: its version and its bin. */
interface StudioLauncher {
  version?: string
  bin?: string
}

/** The launcher, from the package.json its install anchor names; nothing when no launcher booted this Studio. */
function launcherOf(ctx: Context): StudioLauncher {
  const anchor = ctx.get('profileContext')?.installAnchor
  if (anchor === undefined) return {}
  const manifest = JSON.parse(readFileSync(anchor, 'utf8')) as { version?: unknown; bin?: { lyteboat?: unknown } }
  const bin = manifest.bin?.lyteboat
  return {
    ...typeof manifest.version === 'string' ? { version: manifest.version } : {},
    ...typeof bin === 'string' ? { bin: resolve(dirname(anchor), bin) } : {},
  }
}

/** The one-line password piped on stdin; a terminal or an empty line is a usage error. */
function passwordFromStdin(program: Command): string {
  if (process.stdin.isTTY) program.error('error: pipe the password on stdin (it is never a flag, so it stays out of the shell history and the process list)')
  const password = readFileSync(0, 'utf8').split(/\r?\n/u)[0] ?? ''
  if (password === '') program.error('error: the password on stdin is empty')
  return password
}

function roleOf(program: Command, role: string): StudioRole {
  const known = STUDIO_ROLES.find(candidate => candidate === role)
  return known ?? program.error(`error: --role must be one of ${STUDIO_ROLES.join(', ')}`)
}

/** Declare `account add | set-password | remove | list`; each does its change, prints it, and exits 0. */
function accountCommands(program: Command, done: (text: string) => void): void {
  const dir = dshHomePath('studio')
  const account = program.command('account').description('manage the accounts people sign in to Studio with (internal mode)')
  const add = account.command('add <username>')
    .description('make an account with the password on stdin, and grant it a role')
    .requiredOption('--role <role>', `the account's role: ${STUDIO_ROLES.join(', ')}`)
    .option('--display-name <name>', 'the name Studio shows (default: the username)')
    .option('--user-id <id>', 'the user id the role and the audit log name (default: the username)')
  add.action((username: string, options: { role: string; displayName?: string; userId?: string }) => {
    const role = roleOf(add, options.role)
    if (readStudioAccounts(dir)[username] !== undefined) add.error(`error: account ${username} exists; change its password with lyteboat studio account set-password ${username}`)
    const made = setStudioAccount(dir, username, { password: passwordFromStdin(add), ...options.displayName === undefined ? {} : { displayName: options.displayName }, ...options.userId === undefined ? {} : { userId: options.userId } })
    setStudioGrant(dir, made.userId, role, 'cli')
    done(`lyteboat studio: account ${username} (user ${made.userId}) added as ${role}\n`)
  })
  const setPassword = account.command('set-password <username>').description('set an account\'s password from stdin')
  setPassword.action((username: string) => {
    if (readStudioAccounts(dir)[username] === undefined) setPassword.error(`error: no account ${username}`)
    setStudioAccount(dir, username, { password: passwordFromStdin(setPassword) })
    done(`lyteboat studio: password of ${username} set\n`)
  })
  const remove = account.command('remove <username>').description('remove an account; its role grant stays until an admin revokes it on the Users page')
  remove.action((username: string) => {
    if (!removeStudioAccount(dir, username)) remove.error(`error: no account ${username}`)
    done(`lyteboat studio: account ${username} removed\n`)
  })
  account.command('list').description('list the accounts and their roles').action(() => {
    const grants = readStudioGrants(dir)
    const rows = Object.entries(readStudioAccounts(dir)).map(([username, { userId, displayName }]) => `${username}\t${userId}\t${displayName}\t${grants[userId]?.role ?? '(no role)'}\n`)
    done(rows.length === 0 ? 'lyteboat studio: no accounts\n' : `username\tuser id\tdisplay name\trole\n${rows.join('')}`)
  })
}

export default class LyteboatStudioStartup {
  /** Services required before the invocation can be read. */
  static inject = ['cmdlineArgs']

  /**
   * Parse the invocation: provide the Studio's values, or do one account
   * command and exit. A bad flag, a missing directory, or a Studio without
   * accounts in internal mode is a usage error, so nothing is provided.
   * @param ctx - plugin context carrying the command line and the launcher's exit request.
   */
  constructor(ctx: Context) {
    const program = command()
    program.action(() => {
      ctx.provide(LYTEBOAT_STUDIO_STARTUP_SERVICE, studioValuesOf(program, program.opts<StudioServeOptions>(), launcherOf(ctx)))
    })
    accountCommands(program, (text) => {
      // The launcher's CLI output: an account command prints what it changed and ends the process.
      process.stdout.write(text)
      ctx.get('appExit')?.(0)
    })
    parseCmdline(ctx, program)
  }
}
