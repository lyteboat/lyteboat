/**
 * The test window, the right-hand panel where an editor talks to the agent
 * the workspace shows, laid out as the reference implementation's yinglong
 * page: the header (the agent's name, the request-context picker, a new
 * session, the editor's earlier sessions with this agent), the welcome or
 * the conversation, and the input with the stream and thinking switches.
 * Each message is `POST agents/:id/chat`; the answer streams in as the
 * frames arrive (or all at once with streaming off), its thinking in a card
 * that folds once the turn ends, its text and cards in stream order. When
 * the turn ends the panel reads the session once for the line under the
 * answer (skill, outcome, duration) and its 看过程 link, which opens the
 * session at that turn. The contexts are the agent's eval cases', or one
 * typed as a JSON object; the switches act in this browser only.
 * @module @lyteboat/studio-web/client/studio-chat-panel
 */

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import type { JsonValue } from '@lyteboat/contracts'
import type { StudioAgent, StudioSessionSummary } from '@lyteboat/contracts/studio'
import { StudioA2uiCard } from './studio-a2ui-card.tsx'
import { studioApi, studioErrorMessage } from './studio-api-client.ts'
import { useStudioAuth } from './studio-auth-context.tsx'
import {
  STUDIO_CHAT_ANSWER_START,
  foldStudioChatFrame,
  splitStudioChatStream,
  studioChatProfiles,
  studioChatTextBlocks,
  studioChatTurnFacts,
  studioChatWelcome,
  type StudioChatAnswer,
  type StudioChatInline,
  type StudioChatProfile,
  type StudioChatStep,
  type StudioChatTurnFacts,
  type StudioChatWelcome,
} from './studio-chat-messages.ts'
import { StudioChatWelcomeView } from './studio-chat-welcome.tsx'
import { CloseIcon, HistoryIcon, PlusIcon, SendIcon, SparkIcon } from './studio-icons.tsx'
import { formatStudioRelativeTime } from './studio-relative-time.ts'
import { formatStudioSessionSeconds } from './studio-session-format.ts'
import { StudioSwitch } from './studio-switch.tsx'

/** One exchange: the editor's message and the agent's answer. */
interface StudioChatExchange {
  id: string
  question: string
  answer: StudioChatAnswer
  facts?: StudioChatTurnFacts
}

/** The picker's value: a profile's index, no context, or a typed one. */
type StudioChatContextChoice = number | 'none' | 'typed'

const STUDIO_CHAT_NO_WELCOME: StudioChatWelcome = { skills: [], questions: [], pills: [] }
/** The waits before each read of a finished turn's facts; the session index reuses its listing for 2 s. */
const STUDIO_CHAT_FACTS_RETRY_MS = [0, 800, 1600, 2400]

/** The agent's skills and eval cases, read once: what the welcome and the picker offer. */
function useStudioChatOffers(agentId: string): { welcome: StudioChatWelcome; profiles: StudioChatProfile[] } {
  const [offers, setOffers] = useState<{ welcome: StudioChatWelcome; profiles: StudioChatProfile[] }>({ welcome: STUDIO_CHAT_NO_WELCOME, profiles: [] })
  useEffect(() => {
    let current = true
    void Promise.all([studioApi.skills(agentId).catch(() => null), studioApi.evalCases(agentId).catch(() => null)]).then(([skills, cases]) => {
      if (!current) return
      const files = cases?.files ?? []
      setOffers({ welcome: studioChatWelcome(skills?.skills ?? [], files), profiles: studioChatProfiles(files) })
    })
    return () => { current = false }
  }, [agentId])
  return offers
}

/** The conversation: its exchanges, its session, and sending. */
function useStudioChatConversation(agentId: string, streaming: boolean) {
  const [exchanges, setExchanges] = useState<StudioChatExchange[]>([])
  const [sessionId, setSessionId] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const running = useRef<AbortController | null>(null)
  const sessionRef = useRef<string | undefined>(undefined)
  sessionRef.current = sessionId

  useEffect(() => () => running.current?.abort(), [])

  const update = useCallback((id: string, change: (exchange: StudioChatExchange) => StudioChatExchange) => {
    setExchanges(current => current.map(exchange => exchange.id === id ? change(exchange) : exchange))
  }, [])

  const readFacts = useCallback(async (id: string, answer: StudioChatAnswer) => {
    if (answer.sessionId === undefined || answer.turn === undefined) return
    const { sessionId: answerSession, turn } = answer
    // The session index reuses its listing for a moment, so a read right after the turn can miss it or its end.
    for (const delayMs of STUDIO_CHAT_FACTS_RETRY_MS) {
      await new Promise(resolve => setTimeout(resolve, delayMs))
      const detail = await studioApi.sessionDetail(agentId, answerSession).catch(() => null)
      if (detail === null) continue
      const facts = studioChatTurnFacts(detail.items, turn)
      update(id, exchange => ({ ...exchange, facts }))
      if (facts.outcome !== undefined) return
    }
  }, [agentId, update])

  const send = useCallback(async (message: string, context: { [key: string]: JsonValue } | undefined): Promise<string | undefined> => {
    const text = message.trim()
    if (text === '' || running.current !== null) return undefined
    const id = crypto.randomUUID()
    const controller = new AbortController()
    running.current = controller
    setBusy(true)
    setExchanges(current => [...current, { id, question: text, answer: STUDIO_CHAT_ANSWER_START }])
    let answer = STUDIO_CHAT_ANSWER_START
    try {
      const continued = sessionRef.current
      const stream = await studioApi.chat(agentId, { message: text, messageId: id, ...continued === undefined ? {} : { sessionId: continued }, ...context === undefined ? {} : { context } }, controller.signal)
      const reader = stream.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        const split = splitStudioChatStream(buffer + decoder.decode(value, { stream: true }))
        buffer = split.rest
        for (const frame of split.frames) answer = foldStudioChatFrame(answer, frame)
        const shown = answer
        if (streaming) update(id, exchange => ({ ...exchange, answer: shown }))
      }
      if (answer.state === 'running') answer = { ...answer, state: 'failed', error: '连接在这一轮结束前断开了' }
    } catch (error: unknown) {
      answer = { ...answer, state: 'failed', error: controller.signal.aborted ? '已停止' : studioErrorMessage(error) }
    } finally {
      running.current = null
      setBusy(false)
    }
    const final = answer
    update(id, exchange => ({ ...exchange, answer: final }))
    if (final.sessionId !== undefined && sessionRef.current === undefined) setSessionId(final.sessionId)
    void readFacts(id, final)
    return final.sessionId
  }, [agentId, streaming, update, readFacts])

  const reset = useCallback((next?: { sessionId: string; exchanges: StudioChatExchange[] }) => {
    running.current?.abort()
    setSessionId(next?.sessionId)
    setExchanges(next?.exchanges ?? [])
  }, [])

  return { exchanges, sessionId, busy, send, reset, stop: () => running.current?.abort() }
}

/** An earlier session's exchanges, its human messages and answers by turn, without cards. */
async function readStudioChatHistory(agentId: string, sessionId: string): Promise<StudioChatExchange[]> {
  const detail = await studioApi.sessionDetail(agentId, sessionId)
  const exchanges = new Map<number, StudioChatExchange>()
  for (const item of detail.items) {
    if (item.kind === 'user' && !exchanges.has(item.turn)) {
      exchanges.set(item.turn, { id: `${sessionId}:${String(item.turn)}`, question: item.text, answer: { steps: [], parts: [], state: 'finished', sessionId, turn: item.turn } })
    }
    const exchange = exchanges.get(item.turn)
    if (exchange === undefined) continue
    if (item.kind === 'assistant' && item.text !== '') exchange.answer = { ...exchange.answer, parts: [...exchange.answer.parts, { kind: 'text', text: item.text }] }
    if (item.kind === 'turn-end') exchange.answer = { ...exchange.answer, outcome: item.outcome }
  }
  return [...exchanges.values()].map(exchange => ({ ...exchange, facts: studioChatTurnFacts(detail.items, exchange.answer.turn ?? 0) }))
}

function StudioChatInlines({ inlines }: { inlines: StudioChatInline[] }) {
  return <>{inlines.map((inline, index) => inline.kind === 'bold' ? <strong key={index}>{inline.text}</strong> : inline.kind === 'code' ? <code key={index}>{inline.text}</code> : <span key={index}>{inline.text}</span>)}</>
}

function StudioChatText({ text }: { text: string }) {
  const blocks = useMemo(() => studioChatTextBlocks(text), [text])
  return (
    <div className="chat-bubble chat-answer-bubble">
      {blocks.map((block, index) => {
        switch (block.kind) {
          case 'paragraph': return <p key={index}><StudioChatInlines inlines={block.inlines} /></p>
          case 'section': return <h2 key={index}><StudioChatInlines inlines={block.inlines} /></h2>
          case 'fact': return <h3 key={index}><StudioChatInlines inlines={block.inlines} /></h3>
          case 'list': return <ul key={index}>{block.items.map((item, itemIndex) => <li key={itemIndex}><StudioChatInlines inlines={item} /></li>)}</ul>
          case 'table':
            return (
              <div className="chat-table-scroll" key={index}>
                <table>
                  <thead><tr>{block.header.map((cell, column) => <th key={column} style={{ textAlign: block.alignments[column] }}><StudioChatInlines inlines={cell} /></th>)}</tr></thead>
                  <tbody>{block.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, column) => <td key={column} style={{ textAlign: block.alignments[column] }}><StudioChatInlines inlines={cell} /></td>)}</tr>)}</tbody>
                </table>
              </div>
            )
        }
      })}
    </div>
  )
}

function StudioChatThinkingStep({ step }: { step: StudioChatStep }) {
  const [open, setOpen] = useState(false)
  const title = step.kind === 'thinking' ? '思考' : `调用 ${step.name}`
  const detail = step.kind === 'thinking' ? step.text : step.args
  return (
    <div className={`chat-think-step ${open ? 'open' : ''}`}>
      <button className="chat-think-step-head" onClick={() => setOpen(!open)} type="button">
        <span aria-hidden="true" className="chat-think-step-dot" />
        <span className={step.kind === 'tool' ? 'chat-think-step-title mono' : 'chat-think-step-title'}>{title}</span>
        {detail !== '' && <span className="chat-think-step-toggle">{open ? '收起' : '展开'}</span>}
      </button>
      {open && detail !== '' && <div className="chat-think-step-detail">{detail}</div>}
    </div>
  )
}

function StudioChatThinking({ steps, running }: { steps: StudioChatStep[]; running: boolean }) {
  const [open, setOpen] = useState<boolean | null>(null)
  const shown = open ?? running
  return (
    <div className={`chat-thinking ${shown ? '' : 'collapsed'}`}>
      <button aria-expanded={shown} className="chat-thinking-head" onClick={() => setOpen(!shown)} type="button">
        <SparkIcon />
        <span>{running ? '思考中…' : '思考完成'}</span>
        <span aria-hidden="true" className="chat-thinking-chevron">▾</span>
      </button>
      {shown && <div className="chat-thinking-steps">{steps.map((step, index) => <StudioChatThinkingStep key={index} step={step} />)}</div>}
    </div>
  )
}

function StudioChatFacts({ agentId, answer, facts }: { agentId: string; answer: StudioChatAnswer; facts: StudioChatTurnFacts | undefined }) {
  const navigate = useNavigate()
  if (answer.state === 'running') return null
  const parts = [facts?.skill ?? '无技能', facts?.outcome ?? answer.outcome ?? (answer.state === 'failed' ? 'failed' : '…')]
  if (facts?.durationMs !== undefined) parts.push(formatStudioSessionSeconds(facts.durationMs))
  const { sessionId, turn } = answer
  return (
    <div className="chat-facts" title={facts?.model === undefined ? undefined : `模型 ${facts.model}`}>
      <span className="mono">{parts.join(' · ')}</span>
      {sessionId !== undefined && turn !== undefined && (
        <button className="chat-facts-link" onClick={() => void navigate(`/agents/${encodeURIComponent(agentId)}/sessions?${new URLSearchParams({ session: sessionId, turn: String(turn) }).toString()}`)} type="button">
          看过程 ›
        </button>
      )}
    </div>
  )
}

function StudioChatExchangeView({ agentId, exchange, showThinking, onQuery }: { agentId: string; exchange: StudioChatExchange; showThinking: boolean; onQuery(message: string): void }) {
  const { answer } = exchange
  const running = answer.state === 'running'
  return (
    <>
      <div className="chat-msg chat-msg-user"><div className="chat-bubble">{exchange.question}</div></div>
      <div className="chat-msg chat-msg-assistant">
        {showThinking && answer.steps.length > 0 && <StudioChatThinking running={running} steps={answer.steps} />}
        <div className="chat-answer-flow">
          {answer.parts.map((part, index) => part.kind === 'text'
            ? <StudioChatText key={index} text={part.text} />
            : <div className="chat-a2ui-part" key={index}><StudioA2uiCard onQuery={onQuery} payload={part.payload} /></div>)}
          {running && answer.parts.length === 0 && <div className="chat-bubble chat-answer-bubble chat-typing">…</div>}
        </div>
        {answer.state === 'failed' && <div className="chat-error">{answer.error ?? '这一轮没有完成'}</div>}
        <StudioChatFacts agentId={agentId} answer={answer} facts={exchange.facts} />
      </div>
    </>
  )
}

function StudioChatHistory({ agentId, current, onPick, onClose }: { agentId: string; current: string | undefined; onPick(session: StudioSessionSummary): void; onClose(): void }) {
  const { user } = useStudioAuth()
  const [sessions, setSessions] = useState<StudioSessionSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (user === null) return
    studioApi.sessions(agentId, { owner: `operator:${user.userId}`, limit: 20 })
      .then(answer => setSessions(answer.sessions), (failure: unknown) => setError(studioErrorMessage(failure)))
  }, [agentId, user])
  return (
    <div className="chat-history" role="dialog" aria-label="历史会话">
      <div className="chat-history-head">
        <span>我和这个 agent 的会话</span>
        <button aria-label="关闭历史" className="icon-action-button" onClick={onClose} type="button"><CloseIcon /></button>
      </div>
      {error !== null && <div className="chat-history-empty">{error}</div>}
      {sessions === null && error === null && <div className="chat-history-empty">正在加载…</div>}
      {sessions?.length === 0 && current === undefined && <div className="chat-history-empty">还没有测试会话。</div>}
      {/* The index reuses a listing for two seconds, so a session this panel just opened may not be listed yet. */}
      {sessions !== null && current !== undefined && !sessions.some(session => session.sessionId === current) && (
        <button className="chat-history-item active" onClick={onClose} type="button">
          <span className="chat-history-title">当前会话</span>
          <span className="chat-history-meta">刚刚</span>
        </button>
      )}
      {sessions?.map(session => (
        <button className={`chat-history-item ${session.sessionId === current ? 'active' : ''}`} key={session.sessionId} onClick={() => onPick(session)} type="button">
          <span className="chat-history-title">{session.firstMessage ?? session.sessionId}</span>
          <span className="chat-history-meta">{session.turnCount} turns · {formatStudioRelativeTime(session.updatedAt)}</span>
        </button>
      ))}
    </div>
  )
}

function parseTypedContext(typed: string): { context?: { [key: string]: JsonValue }; error?: string } {
  if (typed.trim() === '') return {}
  try {
    const value = JSON.parse(typed) as JsonValue
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return { error: 'context 要是一个 JSON 对象' }
    return { context: value }
  } catch {
    // The message names the field; the parser's own message would name a column of an input the editor cannot see.
    return { error: 'context 不是合法的 JSON' }
  }
}

/** The input, the pills above it, and the switches under it. */
function StudioChatComposer({ busy, pills, streaming, thinking, onSend, onStop, onStreaming, onThinking }: {
  busy: boolean
  pills: string[]
  streaming: boolean
  thinking: boolean
  onSend(message: string): boolean
  onStop(): void
  onStreaming(on: boolean): void
  onThinking(on: boolean): void
}) {
  const [draft, setDraft] = useState('')
  const submit = (): void => {
    if (onSend(draft)) setDraft('')
  }
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    submit()
  }
  return (
    <div className="chat-bottom">
      {pills.length > 0 && (
        <div className="chat-pills">
          {pills.map(pill => <button className="chat-pill" disabled={busy} key={pill} onClick={() => onSend(pill)} type="button">{pill}</button>)}
        </div>
      )}
      <div className="chat-input-card">
        <textarea aria-label="给 agent 发消息" onChange={event => setDraft(event.target.value)} onKeyDown={keyDown} placeholder="输入消息，Enter 发送，Shift+Enter 换行" rows={2} value={draft} />
        <div className="chat-input-bottom">
          {busy
            ? <button className="btn btn-sm" onClick={onStop} type="button">停止</button>
            : <button aria-label="发送" className="chat-send" disabled={draft.trim() === ''} onClick={submit} type="button"><SendIcon /></button>}
        </div>
      </div>
      <div className="chat-switches">
        <label className="chat-switch"><span>流式</span><StudioSwitch checked={streaming} label="流式" onChange={onStreaming} /></label>
        <label className="chat-switch"><span>思考</span><StudioSwitch checked={thinking} label="思考" onChange={onThinking} /></label>
      </div>
    </div>
  )
}

/** The picker of the request context. */
function StudioChatContextPicker({ profiles, choice, onChoice }: { profiles: StudioChatProfile[]; choice: StudioChatContextChoice; onChoice(choice: StudioChatContextChoice): void }) {
  return (
    <select
      aria-label="请求上下文"
      className="chat-context-select"
      onChange={(event) => {
        const value = event.target.value
        onChoice(value === 'none' || value === 'typed' ? value : Number(value))
      }}
      value={String(choice)}
    >
      {profiles.map((profile, index) => <option key={profile.label} value={String(index)}>{profile.label}</option>)}
      <option value="none">不带 context</option>
      <option value="typed">手填…</option>
    </select>
  )
}

/**
 * The test window for one agent; mount it per agent (`key`).
 * @param onClose - closes the panel.
 * @param onResizeStart - starts a drag of the panel's left edge.
 */
export function StudioChatPanel({ agent, onClose, onResizeStart }: { agent: StudioAgent; onClose(): void; onResizeStart(event: ReactPointerEvent<HTMLButtonElement>): void }) {
  const { welcome, profiles } = useStudioChatOffers(agent.id)
  const [streaming, setStreaming] = useState(true)
  const [thinking, setThinking] = useState(true)
  const [choice, setChoice] = useState<StudioChatContextChoice>('none')
  const [typed, setTyped] = useState('')
  const [historyOpen, setHistoryOpen] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const conversation = useStudioChatConversation(agent.id, streaming)
  const scroller = useRef<HTMLDivElement | null>(null)

  // The eval cases' first context is the default, once they are read.
  useEffect(() => { if (profiles.length > 0) setChoice(current => current === 'none' ? 0 : current) }, [profiles])
  useEffect(() => { scroller.current?.scrollTo({ top: scroller.current.scrollHeight }) }, [conversation.exchanges])

  const send = (message: string): boolean => {
    if (message.trim() === '' || conversation.busy) return false
    let context: { [key: string]: JsonValue } | undefined
    if (choice === 'typed') {
      const parsed = parseTypedContext(typed)
      if (parsed.error !== undefined) {
        setNotice(parsed.error)
        return false
      }
      context = parsed.context
    } else if (choice !== 'none') {
      context = profiles[choice]?.context
    }
    setNotice(null)
    void conversation.send(message, context)
    return true
  }
  const pick = (session: StudioSessionSummary): void => {
    setHistoryOpen(false)
    readStudioChatHistory(agent.id, session.sessionId)
      .then(exchanges => conversation.reset({ sessionId: session.sessionId, exchanges }), (error: unknown) => setNotice(studioErrorMessage(error)))
  }

  return (
    <aside aria-label="测试窗" className="chat-panel">
      <button aria-label="调整测试窗宽度" className="chat-panel-resize-handle" onPointerDown={onResizeStart} type="button" />
      <header className="chat-header">
        <span className="chat-header-title" title={agent.id}>{agent.name ?? agent.id}</span>
        <div className="chat-header-actions">
          <StudioChatContextPicker choice={choice} onChoice={setChoice} profiles={profiles} />
          <button aria-label="新会话" className="icon-action-button" onClick={() => conversation.reset()} title="新会话" type="button"><PlusIcon /></button>
          <button aria-label="历史会话" className="icon-action-button" onClick={() => setHistoryOpen(!historyOpen)} title="历史" type="button"><HistoryIcon /></button>
          <button aria-label="关闭测试窗" className="icon-action-button" onClick={onClose} title="关闭" type="button"><CloseIcon /></button>
        </div>
        {historyOpen && <StudioChatHistory agentId={agent.id} current={conversation.sessionId} onClose={() => setHistoryOpen(false)} onPick={pick} />}
      </header>
      {choice === 'typed' && (
        <textarea aria-label="手填 context（JSON 对象）" className="chat-context-typed mono" onChange={event => setTyped(event.target.value)} placeholder='{"customer": "..."}' rows={2} value={typed} />
      )}
      <div className="chat-scroll" ref={scroller}>
        {conversation.exchanges.length === 0
          ? <StudioChatWelcomeView description={agent.description} onSend={message => { send(message) }} welcome={welcome} />
          : conversation.exchanges.map(exchange => <StudioChatExchangeView agentId={agent.id} exchange={exchange} key={exchange.id} onQuery={message => { send(message) }} showThinking={thinking} />)}
      </div>
      {notice !== null && <div className="chat-notice">{notice}</div>}
      <StudioChatComposer
        busy={conversation.busy}
        onSend={send}
        onStop={conversation.stop}
        onStreaming={setStreaming}
        onThinking={setThinking}
        pills={welcome.pills}
        streaming={streaming}
        thinking={thinking}
      />
    </aside>
  )
}
