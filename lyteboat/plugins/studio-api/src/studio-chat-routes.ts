/**
 * The test window's endpoint: `POST agents/:id/chat` sends one message to an
 * agent and answers with the turn as `/chat`'s enterprise event stream. An
 * editor's session is owned by `operator:<their account>`, so they continue
 * only the sessions they opened, and no end user continues one of theirs. The
 * session lands in the same store as end users' sessions, where the Sessions
 * page shows it. Each message is appended to the audit log, without its text.
 * @module @lyteboat/studio-api/studio-chat-routes
 */

import { randomUUID } from 'node:crypto'
import type { ChatApiService } from '@lyteboat/chat-api'
import { studioChatRequestSchema } from '@lyteboat/contracts/studio'
import type { StudioAudit } from './studio-audit.ts'
import { StudioApiError, studioSchemaProblems, type StudioApiRoute } from './studio-api-router.ts'

/**
 * The routes.
 * @param chat - the chatApi service, which runs the turn.
 * @param audit - the Studio's audit log.
 */
export function studioChatRoutes(chat: ChatApiService, audit: StudioAudit): StudioApiRoute[] {
  return [{
    kind: 'stream',
    method: 'POST',
    path: 'agents/:id/chat',
    access: 'editor',
    stream: async (call, response) => {
      const agentId = call.params['id'] ?? ''
      const parsed = studioChatRequestSchema.safeParse(await call.body())
      if (!parsed.success) throw new StudioApiError('invalid_request', studioSchemaProblems(parsed.error, '(the body)'))
      // An editor route always has a caller.
      const actor = call.principal?.userId ?? ''
      const body = parsed.data
      const messageId = body.messageId ?? randomUUID()
      void audit.record({ actor, action: 'chat.send', agent: agentId, message: messageId, ...body.sessionId === undefined ? {} : { session: body.sessionId } })
      await chat.answer({
        agentId,
        owner: { kind: 'operator', id: actor },
        message: body.message,
        sessionId: body.sessionId,
        messageId,
        traceId: undefined,
        stream: true,
        context: body.context,
        history: undefined,
      }, response)
    },
  }]
}
