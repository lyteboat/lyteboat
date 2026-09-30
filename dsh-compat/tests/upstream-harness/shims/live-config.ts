/**
 * lyteboat adaptation: upstream's settings spec imports `liveConfig` from another
 * package's tests (`packages/settings/settings/tests/live-config.ts`), which no
 * published package ships. This is that helper: mount a plugin behind a Loader
 * and edit its raw configuration the way profile reconciliation does.
 * Adapted from deepseek-ai/deepseek-harness @ dsh-v0.2.0-rc.2 (639ed015), MIT,
 * without the `omitsGeneratedPage` helper, which the ported specs do not use.
 */
import { Context, resolveConfig, type Plugin } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'

function merge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const result = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    const before = result[key]
    result[key] = before && typeof before === 'object' && !Array.isArray(before)
      && value && typeof value === 'object' && !Array.isArray(value)
      ? merge(before as Record<string, unknown>, value as Record<string, unknown>) : value
  }
  return result
}

/** Mount a consumer behind Loader and edit its raw configuration. */
export async function liveConfig(ctx: Context, plugin: Plugin, initial: object = {}) {
  if (ctx.get('loader') === undefined) {
    await ctx.plugin(Loader)
  }
  const name = `live-${Object.keys(ctx.loader.builtins).length}`
  ctx.loader.builtins[name] = plugin
  const options = { id: plugin.name ?? name, name: `cordis:${name}`, config: initial }
  const id = await ctx.loader.create(options)
  const entry = ctx.loader.resolve(id)
  await entry.fiber!.await()
  const replace = async (next: Record<string, unknown>) => {
    const fiber = entry.fiber!
    resolveConfig(fiber.runtime!, fiber.ctx.waterfall(fiber, 'internal/config', next, () => next))
    await entry.update({ config: next })
    await entry.fiber!.await()
    ctx.emit('app-boot/config-reload')
  }
  return {
    entry,
    fiber: entry.fiber!,
    update: (patch: Record<string, unknown>) => replace(merge(entry.options.config as Record<string, unknown>, patch)),
    replace,
  }
}
