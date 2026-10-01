/**
 * lyteboat's data directory. Every dsh package reads `DSH_HOME` through
 * `resolveDshHome()` on each call, so the launcher resolves `LYTEBOAT_HOME` and
 * exports it as `DSH_HOME` before any dsh module loads (bin.ts imports this
 * module first and dynamic-imports the rest), unconditionally: a user's own
 * `~/.dsh` never receives lyteboat data. The shared agent configuration root
 * (`DSH_AGENTS_HOME`, default `~/.agents`) is left as the user has it: only
 * dsh's skill filesystem reads it, through its default roots, which the native
 * profiles keep as dsh does and the business base turns off.
 * @module @lyteboat/cli/home
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** Environment variable that overrides the default lyteboat home. */
const LYTEBOAT_HOME_ENV = 'LYTEBOAT_HOME'

/** Directory name of the default lyteboat home under the OS home. */
const LYTEBOAT_HOME_DIR_NAME = '.lyteboat'

/** The dsh environment variable lyteboat's home is exported as. */
const DSH_HOME_ENV = 'DSH_HOME'

function expandHomePath(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

/**
 * Resolve the lyteboat home with the same rules dsh applies to `DSH_HOME`: a blank
 * value counts as unset, and a leading `~` expands to the OS home.
 * @param env - environment mapping to read `LYTEBOAT_HOME` from.
 * @returns the absolute lyteboat home path.
 */
function resolveLyteboatHome(env: Record<string, string | undefined>): string {
  const configured = env[LYTEBOAT_HOME_ENV]
  const selected = configured !== undefined && configured.trim().length > 0
    ? configured
    : join(homedir(), LYTEBOAT_HOME_DIR_NAME)
  return resolve(expandHomePath(selected))
}

/**
 * Export the resolved lyteboat home as `DSH_HOME` for every dsh package in this process.
 * @param env - environment mapping to read and write.
 * @returns the absolute lyteboat home path.
 */
export function installLyteboatHome(env: Record<string, string | undefined> = process.env): string {
  const home = resolveLyteboatHome(env)
  env[DSH_HOME_ENV] = home
  return home
}
