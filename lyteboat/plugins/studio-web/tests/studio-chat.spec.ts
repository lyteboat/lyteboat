/**
 * The test window's model without a browser: the enterprise stream cut into
 * frames and folded into one answer, the answer text cut into blocks, a turn's
 * facts read from its timeline, the welcome and the request contexts built from
 * the agent's skills and cases, the panel's width, and the A2UI bindings a card
 * resolves.
 */
import { describe, expect, it } from 'vitest'
import type { ChatEnterpriseEvent, ChatEnterpriseFrame, ChatEnterpriseFrameData } from '@lyteboat/contracts'
import type { StudioEvalCaseFile, StudioSkillSummary, StudioTimelineItem } from '@lyteboat/contracts/studio'
import {
  STUDIO_CHAT_ANSWER_START,
  foldStudioChatFrame,
  splitStudioChatStream,
  studioChatPanelLayout,
  studioChatProfiles,
  studioChatTextBlocks,
  studioChatTurnFacts,
  studioChatWelcome,
} from '../src/client/studio-chat-messages.ts'
import {
  studioA2uiChildIds,
  studioA2uiHidden,
  studioA2uiLength,
  studioA2uiListItems,
  studioA2uiRowScope,
  studioA2uiSurface,
  studioA2uiText,
  studioA2uiTextSize,
} from '../src/client/studio-a2ui-binding.ts'

function frame(id: number, event: ChatEnterpriseEvent, data: Partial<ChatEnterpriseFrameData> = {}): ChatEnterpriseFrame {
  return {
    protocol: 'AGUI',
    id,
    event,
    data: { code: 'success', conversation_id: 's1', message_id: 'm1', timestamp: '0', ui_protocol: 'text', ui_data: '', turn: 2, agent_name: 'finance', ...data },
  }
}

function skill(name: string): StudioSkillSummary {
  return { name, description: '', modelInvocable: true, userInvocable: true, requiredTools: [] }
}

describe('stream', () => {
  it('splitStudioChatStream returns complete blocks and keeps the incomplete one', () => {
    const first = frame(1, 'run_started')
    const second = frame(2, 'run_finished')
    const text = `event: run_started\ndata: ${JSON.stringify(first)}\n\n: keep-alive\n\ndata: ${JSON.stringify(second)}\n\ndata: {"prot`
    const { frames, rest } = splitStudioChatStream(text)
    expect(frames).toEqual([first, second])
    expect(rest).toBe('data: {"prot')
  })

  it('foldStudioChatFrame builds thinking, tool steps, text, cards, and the outcome in stream order', () => {
    const card = { surfaceId: 'c1', rootComponentId: 'root', components: [] }
    const frames = [
      frame(1, 'run_started'),
      frame(2, 'reasoning_message_content', { ui_data: { think: 'thinking', content: ['先看'] } }),
      frame(3, 'reasoning_message_content', { ui_data: { think: 'thinking', content: ['资产'] } }),
      frame(4, 'reasoning_message_content', { ui_data: { think: 'get_assets', content: [{ customer: 'c1' }] } }),
      frame(5, 'text_message_content', { ui_data: '你好' }),
      frame(6, 'text_message_content', { ui_data: '，世界' }),
      frame(7, 'text_message_content', { ui_protocol: 'A2UI', ui_data: card }),
      frame(8, 'text_message_content', { ui_data: '结束' }),
      frame(9, 'run_finished', { extra: { run_outcome: 'completed' } }),
    ]
    const answer = frames.reduce(foldStudioChatFrame, STUDIO_CHAT_ANSWER_START)
    expect(answer).toEqual({
      steps: [{ kind: 'thinking', text: '先看资产' }, { kind: 'tool', name: 'get_assets', args: '{"customer":"c1"}' }],
      parts: [{ kind: 'text', text: '你好，世界' }, { kind: 'card', payload: card }, { kind: 'text', text: '结束' }],
      state: 'finished',
      outcome: 'completed',
      sessionId: 's1',
      turn: 2,
    })
    expect(STUDIO_CHAT_ANSWER_START).toEqual({ steps: [], parts: [], state: 'running' })
  })

  it('foldStudioChatFrame marks the answer failed with the message when the run errors', () => {
    const answer = foldStudioChatFrame(STUDIO_CHAT_ANSWER_START, frame(1, 'run_error', { ui_data: 'session busy' }))
    expect(answer).toMatchObject({ state: 'failed', error: 'session busy' })
  })
})

describe('text blocks', () => {
  it('studioChatTextBlocks reads headings, lists, tables, bold, and code', () => {
    const text = '## 总览\n### 合计 **12** 元\n- 一\n- `二`\n\n| 名称 | 金额 |\n|:--|--:|\n| a\\|b | 1 |\n\n结尾'
    expect(studioChatTextBlocks(text)).toEqual([
      { kind: 'section', inlines: [{ kind: 'plain', text: '总览' }] },
      { kind: 'fact', inlines: [{ kind: 'plain', text: '合计 ' }, { kind: 'bold', text: '12' }, { kind: 'plain', text: ' 元' }] },
      { kind: 'list', items: [[{ kind: 'plain', text: '一' }], [{ kind: 'code', text: '二' }]] },
      {
        kind: 'table',
        alignments: ['left', 'right'],
        header: [[{ kind: 'plain', text: '名称' }], [{ kind: 'plain', text: '金额' }]],
        rows: [[[{ kind: 'plain', text: 'a|b' }], [{ kind: 'plain', text: '1' }]]],
      },
      { kind: 'paragraph', inlines: [{ kind: 'plain', text: '结尾' }] },
    ])
  })

  it('studioChatTextBlocks keeps a pipe line without a separator as a paragraph', () => {
    expect(studioChatTextBlocks('a | b\nc')).toEqual([
      { kind: 'paragraph', inlines: [{ kind: 'plain', text: 'a | b' }] },
      { kind: 'paragraph', inlines: [{ kind: 'plain', text: 'c' }] },
    ])
  })
})

describe('turn facts', () => {
  it('studioChatTurnFacts reads the last skill, the model, the outcome, and the duration of one turn only', () => {
    const items: StudioTimelineItem[] = [
      { kind: 'user', seq: 1, turn: 1, time: 100, text: 'a', imported: false },
      { kind: 'skill', seq: 2, turn: 1, time: 110, skill: 'old' },
      { kind: 'turn-end', seq: 3, turn: 1, time: 200, outcome: 'completed' },
      { kind: 'user', seq: 4, turn: 2, time: 1000, text: 'b', imported: false },
      { kind: 'skill', seq: 5, turn: 2, time: 1010, skill: 'asset' },
      { kind: 'skill', seq: 6, turn: 2, time: 1020, skill: 'advice' },
      { kind: 'assistant', seq: 7, turn: 2, time: 2000, text: 'x', model: 'deepseek/flash', answeredByAdmission: false, imported: false },
      { kind: 'turn-end', seq: 8, turn: 2, time: 2400, outcome: 'completed' },
    ]
    expect(studioChatTurnFacts(items, 2)).toEqual({ skill: 'advice', model: 'deepseek/flash', outcome: 'completed', durationMs: 1400 })
  })

  it('studioChatTurnFacts returns nothing for a turn the timeline does not have yet', () => {
    expect(studioChatTurnFacts([], 3)).toEqual({})
  })
})

describe('welcome', () => {
  const files: StudioEvalCaseFile[] = [{
    file: 'evals/cases.yml',
    cases: [
      { id: 'a', context: { customer: 'young' }, turns: [{ message: '看看资产', expect: { skill: 'asset' } }, { message: '给点建议', context: { customer: 'old' }, expect: { skill: 'advice' } }] },
      { id: 'b', context: { customer: 'young' }, turns: [{ message: '看看资产', expect: {} }] },
      { id: 'c', context: { customer: 'x', region: 'sh' }, turns: [{ message: '三', expect: {} }] },
      ...['四', '五', '六', '七', '八', '九', '十'].map(message => ({ id: message, turns: [{ message, expect: {} }] })),
    ],
  }]

  it('studioChatProfiles returns each distinct context once, named by its field or its JSON', () => {
    expect(studioChatProfiles(files)).toEqual([
      { label: 'customer: young', context: { customer: 'young' } },
      { label: 'customer: old', context: { customer: 'old' } },
      { label: '{"customer":"x","region":"sh"}', context: { customer: 'x', region: 'sh' } },
    ])
  })

  it('studioChatWelcome pairs skills with the first message expecting them and splits distinct first messages', () => {
    const welcome = studioChatWelcome([skill('asset'), skill('advice'), skill('unused')], files)
    expect(welcome.skills).toEqual([{ skill: 'asset', message: '看看资产' }, { skill: 'advice', message: '给点建议' }, { skill: 'unused' }])
    expect(welcome.questions).toEqual(['看看资产', '三', '四'])
    expect(welcome.pills).toEqual(['五', '六', '七', '八', '九', '十'])
  })
})

describe('panel layout', () => {
  it('studioChatPanelLayout takes a quarter of the viewport within 320 and 440', () => {
    expect(studioChatPanelLayout(1600, undefined)).toEqual({ width: 400, overlay: false })
    expect(studioChatPanelLayout(2400, undefined)).toEqual({ width: 440, overlay: false })
    expect(studioChatPanelLayout(1400, 100)).toEqual({ width: 320, overlay: false })
  })

  it('studioChatPanelLayout overlays the workspace below 1272 px', () => {
    expect(studioChatPanelLayout(1271, undefined)).toEqual({ width: 320, overlay: true })
    expect(studioChatPanelLayout(1272, undefined).overlay).toBe(false)
  })
})

describe('A2UI bindings', () => {
  const payload = {
    surfaceId: 'card-1',
    rootComponentId: 'root',
    components: [
      { id: 'root', component: { Column: { children: { explicitList: ['title', 'rows', ''] } } } },
      { id: 'title', component: { Text: { text: { path: 'title' }, size: 'xlarge' } } },
      { id: 'rows', component: { List: { dataSource: { path: 'items' }, children: ['row'] } } },
    ],
    data: { title: { literalString: '资产' }, items: [{ name: '基金', amount: 10 }, '现金'], flag: 0 },
  }

  it('studioA2uiSurface reads the components by id and ignores other events', () => {
    const surface = studioA2uiSurface(payload)
    expect(surface?.rootId).toBe('root')
    expect(surface?.components.get('title')).toEqual({ type: 'Text', props: { text: { path: 'title' }, size: 'xlarge' } })
    expect(studioA2uiChildIds(surface?.components.get('root')?.props ?? {})).toEqual(['title', 'rows'])
    expect(studioA2uiSurface({ ...payload, event: 'dataModelUpdate' })).toBeNull()
  })

  it('studioA2uiText resolves paths from the row scope first, nested bindings, and literal fallbacks', () => {
    const items = studioA2uiListItems({ path: 'items' }, payload.data)
    const row = studioA2uiRowScope(items[0] ?? null)
    expect(studioA2uiText({ path: 'title' }, null, payload.data)).toBe('资产')
    expect(studioA2uiText({ path: 'name' }, row, payload.data)).toBe('基金')
    expect(studioA2uiText({ path: 'item.amount' }, row, payload.data)).toBe('10')
    expect(studioA2uiText({ path: 'item' }, studioA2uiRowScope(items[1] ?? null), payload.data)).toBe('现金')
    expect(studioA2uiText({ path: 'missing', literalString: '无' }, null, payload.data)).toBe('无')
  })

  it('studioA2uiHidden hides on a truthy value and inverts with negate', () => {
    expect(studioA2uiHidden({ path: 'flag' }, null, payload.data)).toBe(false)
    expect(studioA2uiHidden({ path: 'flag', negate: true }, null, payload.data)).toBe(true)
    expect(studioA2uiHidden(true, null, payload.data)).toBe(true)
  })

  it('studioA2uiLength and studioA2uiTextSize map numbers and names onto CSS', () => {
    expect(studioA2uiLength(50, '%')).toBe('50%')
    expect(studioA2uiLength(8)).toBe('8px')
    expect(studioA2uiLength('auto')).toBe('auto')
    expect(studioA2uiTextSize('xlarge')).toBe('16px')
    expect(studioA2uiTextSize('huge')).toBeUndefined()
  })
})
