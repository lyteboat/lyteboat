/**
 * @lyteboat/studio — the Studio workshop. The bundle patch rides over
 * dsh-base, @lyteboat/host, and @lyteboat/business-base, so an agent's tools
 * and skills mount as they do in `lyteboat serve`: its startup row takes
 * `--agents` and the Studio's flags, the agent catalog declares every agent
 * of those directories and reloads them when they change, and the web server
 * carries studio-auth's sign-in, studio-api's `/api/studio`, and studio-web's
 * pages at `/studio`. No session
 * controller is mounted: Studio reads what serve writes and never creates or
 * continues a session. This row reports where the Studio listens and its
 * agents once the catalog has declared them; an agent that fails is reported,
 * and the rest are served.
 * @module @lyteboat/studio
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@lyteboat/agent-catalog'
import type {} from '@lyteboat/studio-auth'
import type {} from './startup.ts'

export default class LyteboatStudioRunner {
  /** The rows this one reports on. */
  static inject = ['agentCatalog', 'webServer', 'studioAuth', 'lyteboatStudioStartup']

  /**
   * Report the listener and the agents once the catalog has declared them.
   * @param ctx - plugin context carrying the catalog, the web server, and the invocation.
   */
  constructor(ctx: Context) {
    void (async () => {
      await ctx.get('loader')?.await()
      try {
        await ctx.agentCatalog.whenReady()
      } catch (error: unknown) {
        // Not strict: only a root-level fault (two roots holding one id) rejects; the radar reports it too.
        process.stderr.write(`lyteboat studio: ${error instanceof Error ? error.message : String(error)}\n`)
      }
      const { host } = ctx.lyteboatStudioStartup
      process.stdout.write(`lyteboat studio: http://${host}:${String(ctx.webServer.port)}/studio/ (${ctx.studioAuth.mode().mode} sign-in)\n`)
      process.stdout.write(`lyteboat studio: agents ${ctx.agentCatalog.list().map(agent => agent.id).join(', ') || 'none'}\n`)
      for (const failure of ctx.agentCatalog.failures()) process.stderr.write(`lyteboat studio: agent ${failure.id} failed: ${failure.reason}\n`)
    })()
  }
}
