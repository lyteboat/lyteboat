/**
 * The test window's model, without React: the enterprise event stream read
 * from its SSE text and folded into one answer (its thinking steps, then its
 * text and cards in the order they streamed, then how the turn ended); an
 * answer's text cut into the blocks the window draws (the reference
 * implementation's restricted markdown: `##` and `###` headings, `-` lists,
 * pipe tables, `**bold**` and `` `code` ``, everything else plain text); a
 * turn's facts from its session timeline; and what the window offers before
 * the first message: the request contexts of the agent's eval cases, a prompt
 * per skill, and the cases' first messages.
 * @module @lyteboat/studio-web/client/studio-chat-messages
 */

import type { ChatEnterpriseFrame, JsonValue, LyteboatTurnOutcomeKind } from '@lyteboat/contracts'
import type { StudioEvalCaseFile, StudioSkillSummary, StudioTimelineItem } from '@lyteboat/contracts/studio'

/** One step of the thinking card: model reasoning, or a tool the model called. */
export type StudioChatStep =
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; name: string; args: string }

/** One piece of an answer, in stream order. */
export type StudioChatPart =
  | { kind: 'text'; text: string }
  | { kind: 'card'; payload: JsonValue }

/** One assistant answer as its frames build it. */
export interface StudioChatAnswer {
  steps: StudioChatStep[]
  parts: StudioChatPart[]
  state: 'running' | 'finished' | 'failed'
  outcome?: LyteboatTurnOutcomeKind
  /** The `run_error` message. */
  error?: string
  sessionId?: string
  turn?: number
}

/** An answer before its first frame. */
export const STUDIO_CHAT_ANSWER_START: StudioChatAnswer = { steps: [], parts: [], state: 'running' }

function jsonText(value: JsonValue | undefined): string {
  if (value === undefined) return ''
  return typeof value === 'string' ? value : JSON.stringify(value)
}

function isJsonObject(value: JsonValue | undefined): value is { [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function foldReasoning(steps: StudioChatStep[], uiData: JsonValue): StudioChatStep[] {
  if (!isJsonObject(uiData)) return steps
  const think = typeof uiData['think'] === 'string' ? uiData['think'] : ''
  const contents = Array.isArray(uiData['content']) ? uiData['content'] : []
  let next = steps
  for (const content of contents) {
    const last = next.at(-1)
    if (think === 'thinking') {
      next = last?.kind === 'thinking'
        ? [...next.slice(0, -1), { kind: 'thinking', text: last.text + jsonText(content) }]
        : [...next, { kind: 'thinking', text: jsonText(content) }]
    } else if (think !== '') {
      next = [...next, { kind: 'tool', name: think, args: jsonText(content) }]
    }
  }
  return next
}

function foldText(parts: StudioChatPart[], delta: string): StudioChatPart[] {
  const last = parts.at(-1)
  if (last?.kind === 'text') return [...parts.slice(0, -1), { kind: 'text', text: last.text + delta }]
  return delta === '' ? parts : [...parts, { kind: 'text', text: delta }]
}

/**
 * Fold one frame into the answer.
 * @param answer - the answer so far; it is not changed.
 * @param frame - the next frame.
 * @returns the answer with the frame applied.
 */
export function foldStudioChatFrame(answer: StudioChatAnswer, frame: ChatEnterpriseFrame): StudioChatAnswer {
  const { data } = frame
  const known = { ...answer, sessionId: data.conversation_id, turn: data.turn }
  switch (frame.event) {
    case 'reasoning_message_content':
      return { ...known, steps: foldReasoning(answer.steps, data.ui_data) }
    case 'text_message_content':
      if (data.ui_protocol === 'A2UI') return { ...known, parts: [...answer.parts, { kind: 'card', payload: data.ui_data }] }
      return { ...known, parts: foldText(answer.parts, jsonText(data.ui_data)) }
    case 'run_finished': {
      const outcome = data.extra?.['run_outcome']
      return { ...known, state: 'finished', ...typeof outcome === 'string' ? { outcome: outcome as LyteboatTurnOutcomeKind } : {} }
    }
    case 'run_error':
      return { ...known, state: 'failed', error: jsonText(data.ui_data) }
    case 'run_started':
    case 'reasoning_start':
    case 'reasoning_end':
    case 'text_message_start':
    case 'text_message_end':
      return known
  }
}

/**
 * Cut the frames out of a stream's text: blocks end with a blank line, and a
 * `: keep-alive` comment carries none.
 * @param buffer - the text read so far, after the last complete block.
 * @returns the frames, and the text of the block still incomplete.
 */
export function splitStudioChatStream(buffer: string): { frames: ChatEnterpriseFrame[]; rest: string } {
  const frames: ChatEnterpriseFrame[] = []
  let rest = buffer
  let end = rest.indexOf('\n\n')
  while (end >= 0) {
    const block = rest.slice(0, end)
    rest = rest.slice(end + 2)
    end = rest.indexOf('\n\n')
    const data = /^data: (.*)$/mu.exec(block)?.[1]
    if (data !== undefined) frames.push(JSON.parse(data) as ChatEnterpriseFrame)
  }
  return { frames, rest }
}

/** A run of inline text: plain, bold, or code. */
export type StudioChatInline = { kind: 'plain' | 'bold' | 'code'; text: string }

/** One block of an answer's text. */
type StudioChatTextBlock =
  | { kind: 'paragraph'; inlines: StudioChatInline[] }
  | { kind: 'section'; inlines: StudioChatInline[] }
  | { kind: 'fact'; inlines: StudioChatInline[] }
  | { kind: 'list'; items: StudioChatInline[][] }
  | { kind: 'table'; alignments: ('left' | 'center' | 'right')[]; header: StudioChatInline[][]; rows: StudioChatInline[][][] }

/**
 * The inline runs of one line: `**bold**` and `` `code` ``.
 * @param line - one line of answer text.
 */
function studioChatInlines(line: string): StudioChatInline[] {
  const inlines: StudioChatInline[] = []
  const pattern = /\*\*(.+?)\*\*|`([^`]+)`/gu
  let at = 0
  for (const match of line.matchAll(pattern)) {
    if (match.index > at) inlines.push({ kind: 'plain', text: line.slice(at, match.index) })
    inlines.push(match[1] === undefined ? { kind: 'code', text: match[2] ?? '' } : { kind: 'bold', text: match[1] })
    at = match.index + match[0].length
  }
  if (at < line.length) inlines.push({ kind: 'plain', text: line.slice(at) })
  return inlines
}

function tableCells(line: string): string[] {
  let value = line.trim()
  if (value.startsWith('|')) value = value.slice(1)
  const cells: string[] = []
  let cell = ''
  for (let index = 0; index < value.length; index++) {
    const char = value[index]
    const next = value[index + 1]
    if (char === '\\' && (next === '|' || next === '\\')) {
      cell += next
      index++
    } else if (char === '|') {
      cells.push(cell.trim())
      cell = ''
    } else {
      cell += char
    }
  }
  if (cell !== '' || !value.endsWith('|')) cells.push(cell.trim())
  return cells
}

function isTableStart(line: string, separatorLine: string | undefined): boolean {
  if (!line.includes('|') || separatorLine === undefined) return false
  const separators = tableCells(separatorLine)
  return separators.length > 0 && separators.length === tableCells(line).length && separators.every(cell => /^:?-+:?$/u.test(cell))
}

function tableAlignment(separator: string): 'left' | 'center' | 'right' {
  if (separator.startsWith(':')) return separator.endsWith(':') ? 'center' : 'left'
  return separator.endsWith(':') ? 'right' : 'left'
}

/**
 * An answer's text as the blocks the window draws, ported from the reference
 * implementation's advisory text renderer (`static/a2ui-renderer.js`).
 * @param text - the answer text.
 */
export function studioChatTextBlocks(text: string): StudioChatTextBlock[] {
  const lines = text.replace(/\r\n?/gu, '\n').split('\n')
  const blocks: StudioChatTextBlock[] = []
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? ''
    if (isTableStart(line, lines[index + 1])) {
      const header = tableCells(line)
      const alignments = tableCells(lines[index + 1] ?? '').map(tableAlignment)
      const rows: StudioChatInline[][][] = []
      index++
      while (index + 1 < lines.length && (lines[index + 1] ?? '').trim() !== '' && (lines[index + 1] ?? '').includes('|') && !/^\s*#/u.test(lines[index + 1] ?? '')) {
        const cells = tableCells(lines[++index] ?? '')
        rows.push(header.map((_cell, column) => studioChatInlines(cells[column] ?? '')))
      }
      blocks.push({ kind: 'table', alignments, header: header.map(studioChatInlines), rows })
      continue
    }
    const fact = /^###\s+(.+)$/u.exec(line)
    const section = /^##\s+(.+)$/u.exec(line)
    const bullet = /^[-*]\s+(.+)$/u.exec(line)
    const last = blocks.at(-1)
    if (fact?.[1] !== undefined) blocks.push({ kind: 'fact', inlines: studioChatInlines(fact[1]) })
    else if (section?.[1] !== undefined) blocks.push({ kind: 'section', inlines: studioChatInlines(section[1]) })
    else if (bullet?.[1] !== undefined) {
      if (last?.kind === 'list' && (lines[index - 1] ?? '').trim() !== '') last.items.push(studioChatInlines(bullet[1]))
      else blocks.push({ kind: 'list', items: [studioChatInlines(bullet[1])] })
    } else if (line.trim() !== '') blocks.push({ kind: 'paragraph', inlines: studioChatInlines(line) })
  }
  return blocks
}

/** What the line under an answer says about its turn, read from the session. */
export interface StudioChatTurnFacts {
  /** The skill active last in the turn; absent when none was. */
  skill?: string
  outcome?: LyteboatTurnOutcomeKind
  /** From the human message to the turn's end. */
  durationMs?: number
  /** `provider/model` of the turn's last answer. */
  model?: string
}

/**
 * One turn's facts from its session's timeline.
 * @param items - the session's timeline.
 * @param turn - the turn's number.
 */
export function studioChatTurnFacts(items: readonly StudioTimelineItem[], turn: number): StudioChatTurnFacts {
  const facts: StudioChatTurnFacts = {}
  let startedAt: number | undefined
  for (const item of items) {
    if (item.turn !== turn) continue
    if (item.kind === 'user' && startedAt === undefined) startedAt = item.time
    if (item.kind === 'skill') facts.skill = item.skill
    if (item.kind === 'assistant' && item.model !== undefined) facts.model = item.model
    if (item.kind === 'turn-end') {
      facts.outcome = item.outcome
      if (startedAt !== undefined) facts.durationMs = item.time - startedAt
    }
  }
  return facts
}

/** A request context the window offers, named for its picker. */
export interface StudioChatProfile {
  label: string
  context: { [key: string]: JsonValue }
}

/**
 * The distinct request contexts of an agent's eval cases, in case-file order;
 * a context of one field is named `field: value`, a larger one by its JSON.
 * @param files - the agent's case files.
 */
export function studioChatProfiles(files: readonly StudioEvalCaseFile[]): StudioChatProfile[] {
  const profiles = new Map<string, StudioChatProfile>()
  for (const evalCase of files.flatMap(file => file.cases)) {
    for (const context of [evalCase.context, ...evalCase.turns.map(turn => turn.context)]) {
      if (context === undefined || Object.keys(context).length === 0) continue
      const key = JSON.stringify(context)
      if (profiles.has(key)) continue
      const entries = Object.entries(context)
      const [field, value] = entries[0] ?? ['', '']
      profiles.set(key, { label: entries.length === 1 ? `${field}: ${jsonText(value)}` : key, context })
    }
  }
  return [...profiles.values()]
}

/** One cell of the welcome grid: a skill, and the message that tries it. */
export interface StudioChatSkillPrompt {
  skill: string
  /** The first case message that expects this skill; absent when no case does. */
  message?: string
}

/** What the window offers before the first message. */
export interface StudioChatWelcome {
  skills: StudioChatSkillPrompt[]
  /** The first messages of the first three cases. */
  questions: string[]
  /** The first messages of the cases after those, at most six. */
  pills: string[]
}

/**
 * The welcome prompts from an agent's skills and eval cases.
 * @param skills - the agent's skills, in its order.
 * @param files - the agent's case files.
 */
export function studioChatWelcome(skills: readonly StudioSkillSummary[], files: readonly StudioEvalCaseFile[]): StudioChatWelcome {
  const cases = files.flatMap(file => file.cases)
  const turns = cases.flatMap(evalCase => evalCase.turns)
  const firstMessages = [...new Set(cases.flatMap(evalCase => evalCase.turns[0]?.message ?? []))]
  return {
    skills: skills.map((skill) => {
      const message = turns.find(turn => turn.expect.skill === skill.name)?.message
      return message === undefined ? { skill: skill.name } : { skill: skill.name, message }
    }),
    questions: firstMessages.slice(0, 3),
    pills: firstMessages.slice(3, 9),
  }
}

/** The panel's width bounds and its default share of the viewport. */
const STUDIO_CHAT_PANEL_MIN_WIDTH = 320
const STUDIO_CHAT_PANEL_MAX_WIDTH = 440
const STUDIO_CHAT_PANEL_VIEWPORT_SHARE = 0.25
/** Below this viewport width the radar (232), the workspace's least (720), and the panel's least (320) do not fit side by side. */
const STUDIO_CHAT_PANEL_OVERLAY_BELOW = 1272

/**
 * The panel's width and whether it covers the workspace instead of sitting
 * beside it.
 * @param viewportWidth - the window's inner width.
 * @param draggedWidth - the width the editor dragged it to, if any.
 */
export function studioChatPanelLayout(viewportWidth: number, draggedWidth: number | undefined): { width: number; overlay: boolean } {
  const wanted = draggedWidth ?? Math.round(viewportWidth * STUDIO_CHAT_PANEL_VIEWPORT_SHARE)
  return {
    width: Math.min(STUDIO_CHAT_PANEL_MAX_WIDTH, Math.max(STUDIO_CHAT_PANEL_MIN_WIDTH, wanted)),
    overlay: viewportWidth < STUDIO_CHAT_PANEL_OVERLAY_BELOW,
  }
}
