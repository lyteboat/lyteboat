/**
 * lyteboat's extension `session-controller-prompt-source` (dsh-compat/contract/extensions.yml):
 * a prompt can add fields to the source of the user message it appends. The
 * controller writes that source itself (`kind`, the request id as `rpcId`, the
 * client's time zone, the caller as `principal` when it is not the owner), and
 * the source is where a request's facts reach the session log and every
 * consumer of the message; without this, a caller that drives the controller
 * had nowhere to put what it knows about the request.
 * @module @deepseek-ai/dsh-api-session-controller/lyteboat/prompt-source
 */

import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** The fields a prompt request adds to its user message's source. */
export type LyteboatPromptSourceFields = { readonly [key: string]: JsonValue }

/** The source fields the controller writes itself. */
const CONTROLLER_SOURCE_FIELDS: ReadonlySet<string> = new Set(['kind', 'rpcId', 'clientTimeZone', 'principal'])

/**
 * The fields to spread into a prompt's user message source.
 * @param sourceFields - `SessionPromptRequest.sourceFields` as the caller passed it.
 * @returns the caller's fields; none when the request carries none.
 * @throws RemoteError `gateway/bad-request` when a field is one the controller writes.
 */
export function lyteboatPromptSourceFields(sourceFields: LyteboatPromptSourceFields | undefined): LyteboatPromptSourceFields {
  if (sourceFields === undefined) return {}
  const reserved = Object.keys(sourceFields).filter(field => CONTROLLER_SOURCE_FIELDS.has(field))
  if (reserved.length > 0) {
    throw new RemoteError('gateway/bad-request', `sourceFields cannot set ${reserved.join(', ')}: the controller writes them`, {})
  }
  return sourceFields
}
