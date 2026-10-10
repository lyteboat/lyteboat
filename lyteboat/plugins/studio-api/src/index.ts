/**
 * @lyteboat/studio-api — the Studio's HTTP API, `/api/studio/*` on the host
 * web server, JSON in and out. Every request passes the Host allowlist (the
 * loopback names and `trustedHosts`; any other Host is answered 421, which
 * keeps DNS rebinding out), and every answer carries `nosniff`, a
 * `default-src 'none'` CSP, and `no-store`. A route names the least role that
 * may call it; the caller comes from `studioAuth` (a bearer token, or the
 * gateway's headers). Request bodies are JSON, at most `maxBodyBytes`, and
 * checked against the schemas of `@lyteboat/contracts/studio`, an unknown key
 * included. Changes made through the API are appended to the Studio's audit
 * log. The API reads the agents from `agentCatalog` and `agentInspector`,
 * their sessions from `sessionIndex`, serve's run metrics from
 * `turnMetricsReader`, and the eval runs and case files from `evalRecords`.
 * The one session an editor makes is a test-window session: while `chatApi`
 * is mounted, `POST agents/:id/chat` answers through it under the editor's
 * account as an operator, and a Studio without it has no such route; dsh's
 * own `/api` (the client connection) answers 404 here, since the Studio's
 * pages never use it. The one write to an agent is an admin's hot-fix of an
 * existing skill's SKILL.md; an eval run the Studio starts is a `lyteboat
 * eval` process of the launcher's bin (`lyteboatBin`), which a Studio the
 * launcher did not start has none of.
 * @module @lyteboat/studio-api
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import z from '@deepseek-ai/schemastery'
import type {} from '@lyteboat/agent-catalog'
import type {} from '@lyteboat/agent-inspector'
import type {} from '@lyteboat/chat-api'
import type {} from '@lyteboat/contracts'
import type {} from '@lyteboat/eval-runner/records'
import type {} from '@lyteboat/session-index'
import type {} from '@lyteboat/studio-auth'
import type {} from '@lyteboat/turn-metrics/reader'
import { studioAgentRoutes } from './studio-agent-routes.ts'
import { StudioApiRouter } from './studio-api-router.ts'
import { StudioAudit } from './studio-audit.ts'
import { studioAuthRoutes } from './studio-auth-routes.ts'
import { studioChatRoutes } from './studio-chat-routes.ts'
import { studioDashboardRoutes } from './studio-dashboard-routes.ts'
import { StudioEvalJobs } from './studio-eval-jobs.ts'
import { studioEvalRoutes } from './studio-eval-routes.ts'
import { studioSessionRoutes } from './studio-session-routes.ts'
import { studioSystemRoutes } from './studio-system-routes.ts'
import { studioWorkspaceRoutes } from './studio-workspace-routes.ts'

/** Where the API sits on the web server. */
export const STUDIO_API_PREFIX = '/api/studio'

export interface StudioApiConfig {
  /** Where the audit log lives; default `$LYTEBOAT_HOME/studio`, beside the accounts. */
  dir?: string
  /** Host header values accepted beside the loopback names: `name` (any port) or `name:port`. */
  trustedHosts?: string[]
  /** The agent roots, as the System page shows them. */
  agentRoots?: string[]
  /** The launcher's version, as the System page shows it. */
  lyteboatVersion?: string
  /** The tracing UI's URL for one trace, with `{trace_id}` where the id goes. */
  traceLinkTemplate?: string
  /** Environment variables the System page masks whatever their names; an eval process does not inherit them. */
  maskedEnv?: string[]
  maxBodyBytes?: number
  /** The launcher's bin an eval run starts (`node <bin> eval …`); without it the Studio cannot start one. */
  lyteboatBin?: string
}

const STUDIO_API_CONFIG_KEYS = new Set(['dir', 'trustedHosts', 'agentRoots', 'lyteboatVersion', 'traceLinkTemplate', 'maskedEnv', 'maxBodyBytes', 'lyteboatBin'])

/** An eval process's environment: the Studio's own, without the secrets it masks, in the Studio's lyteboat home. */
function studioEvalEnv(masked: readonly string[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, LYTEBOAT_HOME: dshHomePath() }
  for (const variable of masked) delete env[variable]
  return env
}

export default class StudioApiRoutes {
  /** The services the API answers from. */
  static inject = ['webServer', 'studioAuth', 'agentCatalog', 'agentInspector', 'sessionIndex', 'turnMetricsReader', 'evalRecords', 'lyteboatDistro']
  static Config: z<StudioApiConfig> = z.object({
    dir: z.string(),
    trustedHosts: z.array(z.string()).default([]),
    agentRoots: z.array(z.string()).default([]),
    lyteboatVersion: z.string(),
    traceLinkTemplate: z.string(),
    maskedEnv: z.array(z.string()).default([]),
    maxBodyBytes: z.natural().default(1024 * 1024),
    lyteboatBin: z.string(),
  })

  /**
   * Register `/api/studio` on the web server.
   * @param ctx - plugin context carrying the web server, studioAuth, the agent catalog, inspector, and session index, the turn-metrics reader, the eval records, and the distro marker.
   * @param studioApiConfig - the validated config.
   * @throws when a config key is unknown or the trace link template has no `{trace_id}`.
   */
  constructor(ctx: Context, studioApiConfig: StudioApiConfig) {
    // schemastery passes unknown keys through; a misspelt one must not be ignored.
    const unknown = Object.keys(studioApiConfig).filter(key => !STUDIO_API_CONFIG_KEYS.has(key))
    if (unknown.length > 0) throw new Error(`studio-api: unknown config key ${unknown.map(key => JSON.stringify(key)).join(', ')}; allowed: ${[...STUDIO_API_CONFIG_KEYS].join(', ')}`)
    if (studioApiConfig.traceLinkTemplate !== undefined && !studioApiConfig.traceLinkTemplate.includes('{trace_id}')) {
      throw new Error('studio-api: traceLinkTemplate must hold {trace_id}, where a session\'s trace id goes')
    }
    const studioDir = studioApiConfig.dir ?? dshHomePath('studio')
    const audit = new StudioAudit(studioDir, message => ctx.logger.warn(message))
    const jobs = new StudioEvalJobs(studioDir, studioApiConfig.lyteboatBin === undefined ? undefined : {
      bin: studioApiConfig.lyteboatBin,
      agentRoots: studioApiConfig.agentRoots ?? [],
      env: studioEvalEnv(studioApiConfig.maskedEnv ?? []),
    }, message => ctx.logger.warn(message))
    const router = new StudioApiRouter({
      prefix: STUDIO_API_PREFIX,
      trustedHosts: studioApiConfig.trustedHosts ?? [],
      maxBodyBytes: studioApiConfig.maxBodyBytes ?? 1024 * 1024,
      principal: headers => ctx.studioAuth.principal(headers),
      internalError: error => ctx.logger.error(`lyteboat studio api: ${error instanceof Error ? error.stack ?? error.message : String(error)}`),
    }, [
      ...studioAuthRoutes(ctx.studioAuth, audit),
      ...studioSystemRoutes(() => ({
        distro: ctx.lyteboatDistro,
        lyteboatVersion: studioApiConfig.lyteboatVersion,
        agentRoots: studioApiConfig.agentRoots ?? [],
        maskedEnv: studioApiConfig.maskedEnv ?? [],
        env: process.env,
      }), studioApiConfig.traceLinkTemplate),
      ...studioAgentRoutes(ctx.agentCatalog, audit),
      ...studioWorkspaceRoutes({ catalog: ctx.agentCatalog, inspector: ctx.agentInspector, audit }),
      ...studioSessionRoutes(ctx.sessionIndex),
      ...studioDashboardRoutes({ catalog: ctx.agentCatalog, inspector: ctx.agentInspector, sessions: ctx.sessionIndex, metrics: ctx.turnMetricsReader, evals: ctx.evalRecords }),
      ...studioEvalRoutes({ catalog: ctx.agentCatalog, records: ctx.evalRecords, jobs, audit }),
    ])
    ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: STUDIO_API_PREFIX, handler: (request, response) => router.handle(request, response) }), 'studio-api: /api/studio')
    ctx.inject(['chatApi'], (chatCtx) => {
      chatCtx.effect(() => router.mount(studioChatRoutes(chatCtx.chatApi, audit)), 'studio-api: agents/:id/chat')
    })
    // The session controller needs the client connection, which mounts dsh's
    // `/api` for dsh's own web client; the Studio has no such client, so a
    // request there, a signed-in dsh cookie included, is answered 404. The
    // listener refuses, so it does not call `next()`.
    ctx.inject(['connection'], (connectionCtx) => {
      connectionCtx.on('connection/request', async (_request, response) => {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
        response.end('not found')
      })
    })
  }
}
