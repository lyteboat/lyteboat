// A host's own route, written the way a third party would serve one with
// `routes: false`: `POST /test/session-archiver?agent_id&owner_kind&owner_id`
// hands the query to `chatApi.archiveSessions()` and answers `{ archived }`.
// Tests insert it the way `lyteboat serve --plugin <this file>` would.
export const name = 'example-session-archiver'
export const inject = ['chatApi', 'webServer']

export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/test/session-archiver',
    handler: async (request, response) => {
      if (request.method !== 'POST') {
        response.writeHead(405).end()
        return
      }
      const search = new URL(request.url ?? '/', 'http://session-archiver').searchParams
      const archived = await ctx.chatApi.archiveSessions({
        agentId: search.get('agent_id') ?? '',
        owner: { kind: search.get('owner_kind') ?? 'user', id: search.get('owner_id') ?? '' },
      })
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({ archived }))
    },
  }), 'example-session-archiver: /test/session-archiver')
}
