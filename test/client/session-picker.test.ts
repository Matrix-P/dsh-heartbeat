import { describe, expect, it } from 'vitest'

import type { SessionCandidate } from '../../src/client/session-picker.js'
import { toSessionOptions } from '../../src/client/session-picker.js'

const NOW = Date.UTC(2026, 8, 21, 0, 0, 0)
const MIN = 60_000
const HOUR = 3_600_000

function candidate(overrides: Partial<SessionCandidate> = {}): SessionCandidate {
  return {
    sessionId: 'session-abc',
    title: '和朋友的对话',
    kind: 'root',
    updatedAt: NOW - 5 * MIN,
    ...overrides,
  }
}

describe('toSessionOptions — 候选过滤（FR-4 第 2 条 / 需求 12.5）', () => {
  it('过滤掉子 Agent 会话', () => {
    const options = toSessionOptions(
      [
        candidate({ sessionId: 'root-1', title: '主会话' }),
        candidate({ sessionId: 'child-1', title: '子会话', kind: 'subagent' }),
      ],
      NOW,
    )

    expect(options.map((option) => option.sessionId)).toEqual(['root-1'])
  })

  it('不把 sessionId 当主标题 —— 缺失标题时用占位文案', () => {
    const options = toSessionOptions(
      [candidate({ sessionId: 'im:demo:dm:0:sample', title: null })],
      NOW,
    )

    const option = options[0]
    expect(option?.label).toBe('(未命名会话)')
    // 关键：那串丑陋的 id 绝不能出现在标题里
    expect(option?.label).not.toContain('im:')
    expect(option?.sessionId).toContain('im:')
  })

  it('标题只有空白也视为缺失', () => {
    const options = toSessionOptions([candidate({ title: '   ' })], NOW)
    expect(options[0]?.label).toBe('(未命名会话)')
  })

  it('去掉标题首尾空白', () => {
    const options = toSessionOptions([candidate({ title: '  朋友  ' })], NOW)
    expect(options[0]?.label).toBe('朋友')
  })
})

describe('toSessionOptions — 展示字段', () => {
  it('副标题是「最近活跃」的相对时间', () => {
    const options = toSessionOptions([candidate({ updatedAt: NOW - 3 * HOUR })], NOW)
    expect(options[0]?.sublabel).toBe('3小时前')
  })

  it('IM 会话打标签，普通会话没有标签', () => {
    const options = toSessionOptions(
      [
        candidate({ sessionId: 'session-plain', kind: 'root' }),
        candidate({ sessionId: 'im:qq_x:dm:1:abc', kind: 'plugin-channel' }),
      ],
      NOW,
    )

    expect(options.find((option) => option.sessionId === 'session-plain')?.badge).toBeNull()
    expect(options.find((option) => option.kind === 'plugin-channel')?.badge).toBe('IM 会话')
  })

  it('按最近活跃降序排序（最近说话的排最前）', () => {
    const options = toSessionOptions(
      [
        candidate({ sessionId: 'old', updatedAt: NOW - 10 * HOUR }),
        candidate({ sessionId: 'new', updatedAt: NOW - MIN }),
        candidate({ sessionId: 'mid', updatedAt: NOW - 2 * HOUR }),
      ],
      NOW,
    )

    expect(options.map((option) => option.sessionId)).toEqual(['new', 'mid', 'old'])
  })

  it('空输入 → 空数组', () => {
    expect(toSessionOptions([], NOW)).toEqual([])
  })

  it('保留 kind 供界面区分', () => {
    const options = toSessionOptions([candidate({ kind: 'plugin-channel' })], NOW)
    expect(options[0]?.kind).toBe('plugin-channel')
  })
})
