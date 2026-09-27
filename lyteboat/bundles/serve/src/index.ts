/**
 * @lyteboat/serve — lyteboat's service mode. The bundle patch rides over
 * dsh-base and @lyteboat/host: it declares every agent of the `--agents`
 * directories (`@lyteboat/agent-catalog`), mounts dsh's session controller
 * without the web UI (workspace, connection, file upload), and serves `/chat`
 * (`@lyteboat/chat-api`) on the host web server. This row waits for the
 * catalog: an agent that fails to mount stops the service, and otherwise it
 * prints where `/chat` listens and which agents it serves.
 * @module @lyteboat/serve
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-cmdline'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@lyteboat/agent-catalog'
import type {} from '@lyteboat/chat-api'

export default class LyteboatServeRunner {
  /** The rows this one reports on. */
  static inject = ['agentCatalog', 'webServer', 'chatApi']

  /**
   * Report the service once the catalog has declared its agents, or stop it.
   * @param ctx - plugin context carrying the catalog, the web server, and the launcher's exit request.
   */
  constructor(ctx: Context) {
    const exit = ctx.get('appExit')
    if (exit === undefined) throw new Error('lyteboat-serve: the launcher must provide ctx.appExit before the tree mounts')
    void (async () => {
      await ctx.get('loader')?.await()
      try {
        await ctx.agentCatalog.whenReady()
      } catch (error: unknown) {
        process.stderr.write(`lyteboat: ${error instanceof Error ? error.message : String(error)}\n`)
        exit(1)
        return
      }
      const agents = ctx.agentCatalog.list().map(agent => agent.id)
      process.stdout.write(`lyteboat serve: http://${ctx.webServer.host}:${String(ctx.webServer.port)}/chat (agents: ${agents.join(', ') || 'none'})\n`)
    })()
  }
}
