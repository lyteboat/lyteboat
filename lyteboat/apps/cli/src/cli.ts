/**
 * The lyteboat command dispatcher: parse the launcher's own arguments, then boot a
 * profile or print its composition. Loaded by bin.ts only after the lyteboat home
 * has been exported as `DSH_HOME`.
 * @module @lyteboat/cli/cli
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot'
import { parseLyteboatArgs, type LyteboatVersions } from './args.ts'
import { pluginOverlay } from './plugins.ts'
import { LyteboatProfileError, NAME } from './profile-boot.ts'

/** Read lyteboat's own version and the installed dsh version. */
function readVersions(): LyteboatVersions {
  const manifest = JSON.parse(
    readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
  ) as { version?: unknown }
  const lyteboat = typeof manifest.version === 'string' ? manifest.version : '0.0.0'
  let dsh = 'unknown'
  try {
    const require = createRequire(import.meta.url)
    const upstream = JSON.parse(readFileSync(require.resolve('@deepseek-ai/dsh-app-boot/package.json'), 'utf8')) as { version?: unknown }
    if (typeof upstream.version === 'string') dsh = upstream.version
  } catch {
    // The launcher still runs without the installed dsh version being readable.
  }
  return { lyteboat, dsh }
}

/**
 * Run the lyteboat command line.
 * @returns a promise that settles when the selected command mode finishes.
 */
export async function runCli(): Promise<void> {
  const invocation = parseLyteboatArgs(process.argv.slice(2), readVersions())
  try {
    switch (invocation.mode) {
      case 'profile': {
        const { runProfile } = await import('./profile-boot.ts')
        await runProfile({
          environment: loadLayeredEnv(NAME),
          profile: invocation.profile,
          patchFiles: invocation.patches,
          launcherOverlays: pluginOverlay(invocation.plugins),
          args: invocation.args,
        })
        break
      }
      case 'dump-config': {
        const { runDumpConfig } = await import('./dump-config.ts')
        runDumpConfig(invocation.profile, invocation.defaultOnly, invocation.patches, pluginOverlay(invocation.plugins))
        break
      }
      default:
        invocation satisfies never
        throw new Error(`lyteboat: unhandled invocation ${JSON.stringify(invocation)}`)
    }
  } catch (error) {
    // A refused profile is the user's to fix from the message alone (an older lyteboat's
    // directory, a missing bundle); a stack would only bury it.
    if (!(error instanceof LyteboatProfileError)) throw error
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  }
}
