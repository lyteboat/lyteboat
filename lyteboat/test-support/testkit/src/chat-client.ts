/**
 * A test client for a lyteboat `/chat` endpoint: one JSON answer, or the
 * enterprise event stream read frame by frame; and for the Studio's test
 * window, which answers with the same stream. It knows the wire only (the
 * `event:` / `data:` lines and `: keep-alive` comments), not chat-api's types,
 * so this package never depends on a plugin.
 * @module @lyteboat/testkit/chat-client
 */

/** One enterprise frame as the wire carries it. */
export interface ChatWireFrame {
  protocol: string
  id: number
  event: string
  data: { [key: string]: unknown }
}

/** What a stream delivered before it ended or the caller left. */
export interface ChatStreamResult {
  status: number
  /** The frames, in wire order; a refused request has none. */
  frames: ChatWireFrame[]
  /** How many `: keep-alive` comments arrived. */
  keepAlives: number
  /** The body of a refused request (a status other than 200). */
  refusal: unknown
}

export interface ChatCallOptions {
  /** Sent as `Authorization: Bearer <token>`. */
  token?: string
  /** Called when the stream opens: the endpoint accepted the message. */
  onOpen?: () => void
  /** Called for each frame as it arrives; `leave()` closes the connection, as a caller that goes away. */
  onFrame?: (frame: ChatWireFrame, leave: () => void) => void
}

function headers(options: ChatCallOptions): Record<string, string> {
  return { 'content-type': 'application/json', ...options.token === undefined ? {} : { authorization: `Bearer ${options.token}` } }
}

/**
 * POST a request to `/chat` and read its JSON answer.
 * @param url - the endpoint, `http://host:port/chat`.
 * @param body - the request, sent as JSON (a string is sent as is).
 * @returns the status and the parsed body.
 */
export async function postChat(url: string, body: unknown, options: ChatCallOptions = {}): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, { method: 'POST', headers: headers(options), body: typeof body === 'string' ? body : JSON.stringify(body) })
  return { status: response.status, body: await response.json() as unknown }
}

/**
 * POST a streaming request to `/chat` and read its frames until the stream
 * ends or the caller leaves.
 * @param url - the endpoint, `http://host:port/chat`.
 * @param body - the request; `stream: true` is added.
 * @returns the status, the frames, and the keep-alive count.
 */
export async function streamChat(url: string, body: { [key: string]: unknown }, options: ChatCallOptions = {}): Promise<ChatStreamResult> {
  return postForStream(url, { ...body, stream: true }, options)
}

/**
 * POST a message to the Studio's test window (`/api/studio/agents/:id/chat`)
 * and read its frames until the stream ends or the caller leaves.
 * @param url - the endpoint.
 * @param body - the request, sent as it is.
 * @param options - `token` is the Studio's bearer token.
 * @returns the status, the frames, and the keep-alive count.
 */
export async function streamStudioChat(url: string, body: { [key: string]: unknown }, options: ChatCallOptions = {}): Promise<ChatStreamResult> {
  return postForStream(url, body, options)
}

async function postForStream(url: string, body: { [key: string]: unknown }, options: ChatCallOptions): Promise<ChatStreamResult> {
  const leaving = new AbortController()
  const response = await fetch(url, { method: 'POST', headers: headers(options), body: JSON.stringify(body), signal: leaving.signal })
  if (response.status !== 200 || response.body === null) return { status: response.status, frames: [], keepAlives: 0, refusal: await response.json() as unknown }
  options.onOpen?.()
  const frames: ChatWireFrame[] = []
  let keepAlives = 0
  let pending = ''
  const decoder = new TextDecoder()
  const leave = (): void => { leaving.abort() }
  try {
    for await (const chunk of response.body) {
      pending += decoder.decode(chunk, { stream: true })
      let end = pending.indexOf('\n\n')
      while (end >= 0) {
        const block = pending.slice(0, end)
        pending = pending.slice(end + 2)
        end = pending.indexOf('\n\n')
        if (block.startsWith(': keep-alive')) {
          keepAlives += 1
          continue
        }
        const data = /^data: (.*)$/mu.exec(block)?.[1]
        if (data === undefined) throw new Error(`chat-client: a block without a data line: ${JSON.stringify(block)}`)
        const frame = JSON.parse(data) as ChatWireFrame
        frames.push(frame)
        options.onFrame?.(frame, leave)
      }
    }
  } catch (error: unknown) {
    // Leaving aborts the body; the frames read before it are the result.
    if (!leaving.signal.aborted) throw error
  }
  return { status: response.status, frames, keepAlives, refusal: undefined }
}
