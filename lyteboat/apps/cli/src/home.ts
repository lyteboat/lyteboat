/**
 * lyteboat's data directory. Every dsh package reads `DSH_HOME` through
 * `resolveDshHome()` on each call, so the launcher resolves `LYTEBOAT_HOME` and
 * exports it as `DSH_HOME` before any dsh module loads (bin.ts imports this
 * module first and dynamic-imports the rest). It exports `<home>/.agents` as
 * `DSH_AGENTS_HOME` too, the shared agent configuration root dsh's skill
 * filesystem otherwise reads from `~/.agents` where its default roots are on;
 * not the home itself, whose `skills/` would then be both roots. Both
 * overrides are unconditional: a user's own homes never receive lyteboat data
 * or lend it their skills.
 * @module @lyteboat/cli/home
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** Environment variable that overrides the default lyteboat home. */
const LYTEBOAT_HOME_ENV = 'LYTEBOAT_HOME'

/** Directory name of the default lyteboat home under the OS home. */
const LYTEBOAT_HOME_DIR_NAME = '.lyteboat'

/** The dsh environment variables lyteboat's home is exported as. */
const DSH_HOME_ENV = 'DSH_HOME'
const DSH_AGENTS_HOME_ENV = 'DSH_AGENTS_HOME'

/** The shared agent configuration root's directory under the lyteboat home. */
const AGENTS_HOME_DIR_NAME = '.agents'

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
 * Export the resolved lyteboat home as `DSH_HOME`, and its `.agents` as `DSH_AGENTS_HOME`, for every dsh package in this process.
 * @param env - environment mapping to read and write.
 * @returns the absolute lyteboat home path.
 */
export function installLyteboatHome(env: Record<string, string | undefined> = process.env): string {
  const home = resolveLyteboatHome(env)
  env[DSH_HOME_ENV] = home
  env[DSH_AGENTS_HOME_ENV] = join(home, AGENTS_HOME_DIR_NAME)
  return home
}
