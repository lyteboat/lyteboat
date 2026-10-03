/**
 * Who may continue a session over `/chat`: only the end user who owns it. A
 * session owned by another user, by an operator, by
 * lyteboat itself (an eval run), or by nobody is not theirs to continue.
 * @module @lyteboat/chat-api/chat-session-owner
 */

import type { LyteboatRequestOwner } from '@lyteboat/contracts'

/**
 * Whether a `/chat` caller owns a session.
 * @param owner - the session's owner (the lyteboatRequest projection's), null or absent when none was recorded.
 * @param userId - the caller's `user_id`.
 */
export function isChatSessionOwner(owner: LyteboatRequestOwner | null | undefined, userId: string): boolean {
  return owner?.kind === 'user' && owner.id === userId
}
