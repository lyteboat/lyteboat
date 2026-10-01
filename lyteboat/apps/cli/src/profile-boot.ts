/**
 * Shared profile boot for every `lyteboat` surface: initialize the profile from
 * lyteboat's template on first use, resolve it and the installation's runtime
 * package resolution, stack its patch layers (bundle layers in
 * `dsh.profile.bundles` order, the profile's own `cordis.patch.yml`, the
 * home-level layer, `--patch` and launcher overlays, the telemetry switch),
 * mount the tree over the profile's empty root config with the profile's
 * facts provided as `ctx.profileContext`, and wire fail-loud plus bounded
 * shutdown. Live reload of the user layers is dsh-base's `hmr` row, which
 * recomposes from those facts; a bundle that applies patches only at startup
 * disables that row.
 *
 * App flags are not the launcher's business: the invocation's inner arguments
 * are provided to the tree through `ctx.cmdlineArgs`.
 *
 * Adapted from deepseek-ai/deepseek-harness apps/cli/src/profile-boot.ts
 * @ dsh-v0.2.0-rc.2 (639ed015), MIT — see THIRD_PARTY_NOTICES.md. Changes:
 * lyteboat's own template table replaces dsh's shipped-profile initialization,
 * `--from-default-profile` and the application-owned profile runtime are
 * dropped, a skipped bundle the profile's lyteboat template lists fails the
 * boot instead of being reported, the launcher's own overlays (`--plugin`)
 * sit above the `--patch` overlays, a startup failure is left to the process
 * exit instead of disposing the tree and the proxy first (the launcher is the
 * only caller, and its process ends on the error), and `FiberState` reads go
 * through `FIBER_STATE` (`fiber-state.ts`).
 * @module @lyteboat/cli/profile-boot
 */

import { existsSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import {
  boot,
  createRuntimeResolution,
  initProfile,
  installFailLoud,
  loadOverlayPatches,
  loadProfile,
  reportSkippedBundles,
  PluginPackages,
  PROFILE_PATCH_FILENAME,
  readProfileManifest,
  readProfilePatches,
  resolveProfileDir,
  type Profile,
  type ProfileContext,
  type RuntimeResolution,
} from '@deepseek-ai/dsh-app-boot'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { installProxyFromEnvironment } from '@deepseek-ai/dsh-http-proxy'
import { DSH_LAUNCH_ENVIRONMENT_KEY, type LaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { provideCmdline, type AppReady } from '@deepseek-ai/dsh-cmdline'
import { FIBER_STATE } from './fiber-state.ts'
import { inactiveModeRunner } from './mode-runners.ts'
import { createProcessShutdown, type ProcessShutdown } from './process-shutdown.ts'
import { LYTEBOAT_PROFILE_TEMPLATES } from './templates.ts'

/** The launcher's diagnostic prefix and the bin name env layers are read for. */
export const NAME = 'lyteboat'

/** Launcher-owned readiness signal committed only after boot and host setup succeed. */
function createAppReady(): { service: AppReady; commit(): void } {
  let ready = false
  const listeners = new Set<() => void>()
  return {
    service: {
      onReady(listener) {
        if (ready) {
          listener()
          return () => {}
        }
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    },
    commit() {
      if (ready) return
      ready = true
      for (const listener of [...listeners]) listener()
      listeners.clear()
    },
  }
}

/**
 * The home-level user patch layer (`$LYTEBOAT_HOME/cordis.patch.yml`), applied over
 * every profile's own layer. Resolved per call: the home is set by the launcher.
 * @returns the absolute patch-file path.
 */
export function homePatchPath(): string {
  return join(resolveDshHome(), PROFILE_PATCH_FILENAME)
}

/** Absolute path of this lyteboat installation's package.json (src/ and lib/ both sit one level under apps/cli). */
const INSTALL_ANCHOR = fileURLToPath(new URL('../package.json', import.meta.url))

/** The empty root entry list every profile tree patches over. */
const PROFILE_ROOT_CONFIG = `# lyteboat profile root — an empty entry list. The tree is composed as patches:
# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any
# --patch overlays. Edit cordis.patch.yml, not this file.
[]
`

/** Root config filename inside a profile directory. */
export const PROFILE_ROOT_FILENAME = 'cordis.yml'

/**
 * Initialize a profile directory from lyteboat's template when it does not exist
 * yet. An existing directory is never rewritten, so one created by an earlier
 * lyteboat whose bundle list differs from today's template fails loud with the fix
 * instead of booting without the bundles this lyteboat relies on; a user's own
 * changes belong in the profile's `cordis.patch.yml`, not in its bundle list.
 * A name without a lyteboat template is handed to dsh's loader, which knows dsh's
 * own shipped templates and rejects anything else.
 * @param name - the profile name.
 * @param home - the harness home.
 */
export function ensureProfileInitialized(name: string, home: string = resolveDshHome()): void {
  const dir = resolveProfileDir(name, home)
  const template = LYTEBOAT_PROFILE_TEMPLATES[name]
  if (!existsSync(join(dir, 'package.json'))) {
    if (template !== undefined) initProfile(dir, template.bundles)
    return
  }
  if (template === undefined) return
  const bundles = readProfileManifest(NAME, dir).dsh?.profile?.bundles ?? []
  if (bundles.length === template.bundles.length && bundles.every((bundle, index) => bundle === template.bundles[index])) return
  throw new Error(
    `${NAME}: profile "${name}" at ${dir} lists bundles [${bundles.join(', ')}], but this lyteboat's "${name}" template is [${template.bundles.join(', ')}]. `
    + `Set dsh.profile.bundles in ${join(dir, 'package.json')} to the template's list, or move the directory away to have it recreated (keep your cordis.patch.yml).`,
  )
}

/**
 * Refuse a profile that dsh loaded without a bundle its lyteboat template
 * lists, and report every other skipped bundle the way dsh's launcher does.
 * dsh skips a bundle it cannot resolve, or whose dsh peers the running
 * release does not satisfy, and boots the rest; without `@lyteboat/base` or
 * its mode bundle (`@lyteboat/headless`, `@lyteboat/serve`, …) that is a different application than the profile names.
 * @param name - the profile name.
 * @param profile - the bundles dsh skipped while loading it.
 * @throws when a skipped bundle is one the profile's lyteboat template lists.
 */
export function checkSkippedProfileBundles(name: string, profile: Pick<Profile, 'skippedBundles'>): void {
  const templateBundles = LYTEBOAT_PROFILE_TEMPLATES[name]?.bundles ?? []
  const required = profile.skippedBundles.filter(skipped => templateBundles.includes(skipped.packageName))
  reportSkippedBundles(NAME, { skippedBundles: profile.skippedBundles.filter(skipped => !required.includes(skipped)) })
  if (required.length === 0) return
  throw new Error(
    `${NAME}: profile "${name}" cannot boot without the bundles its template lists; skipped: `
    + required.map(({ packageName, reason }) => `${packageName} (${reason})`).join('; '),
  )
}

/**
 * Load a resolved profile for `name` and (re)write the empty root config. The
 * root is always rewritten: the whole composition is patch layers, and the
 * Loader's tree write-back can bake composed rows into this file.
 * @param name - the profile name.
 * @param userLayer - `false` skips parsing `cordis.patch.yml` (the default dump).
 * @returns the loaded profile.
 * @throws when dsh skipped a bundle the profile's lyteboat template lists.
 */
export function prepareProfile(name: string, userLayer = true): Profile {
  ensureProfileInitialized(name)
  const profile = loadProfile(NAME, name, INSTALL_ANCHOR, undefined, { userLayer })
  checkSkippedProfileBundles(name, profile)
  writeFileSync(join(profile.dir, PROFILE_ROOT_FILENAME), PROFILE_ROOT_CONFIG)
  return profile
}

/** One profile's boot inputs. */
interface ComposedProfile {
  profile: Profile
  /** The installation's package resolution, computed before any plugin imports. */
  resolution: RuntimeResolution
  /** Layers above the user layers: `--patch` overlays, then the launcher's own. */
  overlays: PatchOptions[]
}

/**
 * Load `name`, resolve the installation's packages for it, and read its overlays.
 * @param name - the profile name.
 * @param patchFiles - `--patch` overlay paths, in argv order.
 * @param launcherOverlays - in-memory layers the launcher derives from its own flags.
 * @returns the profile, its package resolution, and its overlays.
 */
async function composeProfile(
  name: string,
  patchFiles: readonly string[],
  launcherOverlays: readonly PatchOptions[],
): Promise<ComposedProfile> {
  const profile = prepareProfile(name, true)
  const resolution = await createRuntimeResolution({ installAnchor: INSTALL_ANCHOR, profile })
  // Launcher-generated layers (`--plugin` rows) sit above every file overlay so a
  // user file can never displace them.
  const overlays = [...patchFiles.flatMap(file => loadOverlayPatches(NAME, resolve(file))), ...launcherOverlays]
  return { profile, resolution, overlays }
}

/** Options for {@link runProfile}. */
interface RunProfileOptions {
  /** This run's frozen environment snapshot, provided before any entry mounts. */
  environment: LaunchEnvironmentSnapshot
  /** The profile name to boot. */
  profile: string
  /** `--patch` overlay paths, in argv order. */
  patchFiles: readonly string[]
  /** In-memory layers derived from launcher flags, applied above every file overlay. */
  launcherOverlays?: readonly PatchOptions[]
  /** The invocation's inner arguments, handed to the tree through `ctx.cmdlineArgs`. */
  args: readonly string[]
}

/**
 * Boot one profile invocation end to end and leave process lifetime to the
 * mounted plugins (or to a one-shot runner the composition mounts).
 * @param options - environment snapshot, profile name, overlays, and the booted app's own arguments.
 * @returns the settled root context and the shutdown controller.
 */
export async function runProfile(options: RunProfileOptions): Promise<{ ctx: Context; shutdown: ProcessShutdown }> {
  // Before the first plugin mounts: Node's fetch ignores the proxy environment on its own.
  const disposeProxy = await installProxyFromEnvironment(
    options.environment,
    (message) => { process.stderr.write(`${NAME}: ${message}\n`) },
  )

  const composed = await composeProfile(options.profile, options.patchFiles, options.launcherOverlays ?? [])
  const app: { current?: Context } = {}
  const appReady = createAppReady()
  const shutdown = createProcessShutdown(async () => {
    await app.current?.fiber.dispose()
    await disposeProxy()
  })
  const signalShutdown = new AbortController()
  const interrupt = (code: number): void => {
    signalShutdown.abort()
    shutdown.interrupt(code)
  }
  // SIGTERM is a supervisor's ordinary stop request and exits 0; SIGINT is a user interrupt and reports 130.
  process.on('SIGTERM', () => { interrupt(0) })
  process.on('SIGINT', () => { interrupt(130) })
  installFailLoud(NAME, process, async () => {
    await app.current?.fiber.dispose()
  })

  const rootConfig = join(composed.profile.dir, PROFILE_ROOT_FILENAME)
  // The facts dsh-base's `hmr` row recomposes the live user layers from:
  // bundle layers below, the profile and home layers, overlays above.
  const profileContext: ProfileContext = {
    name: options.profile,
    dir: composed.profile.dir,
    patchPath: composed.profile.patchPath,
    installAnchor: INSTALL_ANCHOR,
    startedBundles: composed.profile.layers.map(layer => layer.packageName),
    cwd: process.cwd(),
    home: resolveDshHome(),
    overlays: composed.overlays,
    telemetryDisabledEnv: process.env['DSH_TELEMETRY_DISABLED'],
  }
  let exitRequested = false
  const ctx = await boot(NAME, rootConfig, readProfilePatches(NAME, profileContext, composed.profile), async (hostCtx) => {
    app.current = hostCtx
    hostCtx.provide('profileContext', profileContext)
    hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, options.environment)
    // Bare row names resolve through the installation's dependency graph.
    await hostCtx.plugin(PluginPackages, { resolution: composed.resolution })
    provideCmdline(hostCtx, {
      args: options.args,
      exit: (code) => {
        exitRequested = true
        void shutdown.shutdown(code)
      },
      ready: appReady.service,
    })
  })
  app.current = ctx
  // A runner that already asked to exit is tearing the tree down, and has reported why.
  const inactiveRunner = exitRequested ? undefined : inactiveModeRunner(ctx)
  if (inactiveRunner !== undefined) {
    // The launcher reports its own startup failures on stderr, as dsh's audit does.
    process.stderr.write(`${NAME}: startup failed: ${inactiveRunner} did not activate (the entries above say why)\n`)
    void shutdown.shutdown(1)
    return { ctx, shutdown }
  }
  if (!signalShutdown.signal.aborted
    && ctx.fiber.state === FIBER_STATE.ACTIVE
    && ctx.get('loader') !== undefined) {
    appReady.commit()
  }
  return { ctx, shutdown }
}
