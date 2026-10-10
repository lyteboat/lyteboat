/**
 * Who may continue a session: only the owner who started it. Over `/chat`
 * that is the end user; in the Studio's test window, the account that opened
 * it. A session owned by anyone else, by lyteboat itself (an eval run), or by
 * nobody is not theirs to continue.
 * @module @lyteboat/chat-api/chat-session-owner
 */

import type { LyteboatRequestOwner } from '@lyteboat/contracts'

/**
 * Whether a caller owns a session.
 * @param owner - the session's owner (the lyteboatRequest projection's), null or absent when none was recorded.
 * @param caller - who the request speaks for.
 */
export function isChatSessionOwner(owner: LyteboatRequestOwner | null | undefined, caller: LyteboatRequestOwner): boolean {
  return owner?.kind === caller.kind && owner.id === caller.id
}
