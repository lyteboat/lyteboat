/**
 * Config-dump entry for `lyteboat config dump`: compose the profile's patch layers
 * through the include plugin's patch algorithm without booting or evaluating
 * `!!js`, with one source layer per bundle, the profile's own patch file, and
 * each `--patch` overlay.
 *
 * Adapted from deepseek-ai/deepseek-harness apps/cli/src/dump-config.ts
 * @ dsh-v0.2.0-rc.2 (639ed015), MIT — see THIRD_PARTY_NOTICES.md.
 * @module @lyteboat/cli/dump-config
 */

import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import {
  loadOptionalPatches,
  loadOverlayPatches,
  renderConfigDump,
  type ConfigDumpLayer,
} from '@deepseek-ai/dsh-app-boot'
import { homePatchPath, NAME, prepareProfile, PROFILE_ROOT_FILENAME } from './profile-boot.ts'

/**
 * Print a profile composition with comments naming each source file and patch layer.
 * @param profile - the profile name.
 * @param defaultOnly - omit the profile's user layer and `--patch` overlays.
 * @param patches - `--patch` overlay paths, in argv order.
 * @param launcherOverlays - in-memory layers derived from launcher flags (`--plugin` rows).
 */
export function runDumpConfig(
  profile: string,
  defaultOnly: boolean,
  patches: readonly string[],
  launcherOverlays: readonly PatchOptions[] = [],
): void {
  const loaded = prepareProfile(profile, !defaultOnly)
  const layers: ConfigDumpLayer[] = loaded.layers.map(layer => ({
    label: layer.packageName,
    patches: layer.patches,
  }))
  if (!defaultOnly) {
    if (existsSync(loaded.patchPath)) {
      layers.push({ label: loaded.patchPath, patches: loaded.patches })
    }
    const homePatchFile = homePatchPath()
    const homePatches = loadOptionalPatches(NAME, homePatchFile)
    if (homePatches !== undefined) {
      layers.push({ label: homePatchFile, patches: homePatches })
    }
    for (const file of patches) {
      const absolute = resolve(file)
      layers.push({ label: absolute, patches: loadOverlayPatches(NAME, absolute) })
    }
    if (launcherOverlays.length > 0) layers.push({ label: 'launcher: --plugin', patches: [...launcherOverlays] })
  }
  process.stdout.write(renderConfigDump(NAME, join(loaded.dir, PROFILE_ROOT_FILENAME), layers))
}
