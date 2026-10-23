// A host's own route, written the way a third party would serve one with
// `routes: false`: `GET /test/history-reader?agent_id&owner_kind&owner_id&session_id[&limit]`
// hands the query to `chatApi.history()` and answers `{ found: false }` or
// `{ found: true, entries }`. Tests insert it the way `lyteboat serve --plugin <this file>` would.
export const name = 'example-history-reader'
export const inject = ['chatApi', 'webServer']

export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/test/history-reader',
    handler: async (request, response) => {
      const search = new URL(request.url ?? '/', 'http://history-reader').searchParams
      const limit = search.get('limit')
      const entries = await ctx.chatApi.history({
        agentId: search.get('agent_id') ?? '',
        owner: { kind: search.get('owner_kind') ?? 'user', id: search.get('owner_id') ?? '' },
        sessionId: search.get('session_id') ?? '',
        ...limit === null ? {} : { limit: Number(limit) },
      })
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify(entries === undefined ? { found: false } : { found: true, entries }))
    },
  }), 'example-history-reader: /test/history-reader')
}
