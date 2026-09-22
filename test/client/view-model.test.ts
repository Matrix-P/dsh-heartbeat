import { describe, expect, it } from 'vitest'

import {
  describeElapsed,
  describeEta,
  describeNoReply,
  describeStatus,
  explainError,
  toTaskRowView,
} from '../../src/client/view-model.js'
import type { TaskSnapshot } from '../../src/runtime/orchestrator.js'

const NOW = Date.UTC(2026, 8, 21, 0, 0, 0)
const MIN = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000

function snapshot(overrides: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return {
    id: 'daily',
    name: '早间问候',
    status: 'armed',
    nextFireAt: NOW + 30 * MIN,
    fireCount: 3,
    noReplyStreak: 0,
    lastResult: 'queued',
    lastFiredAt: NOW - DAY,
    suspendReason: null,
    suspendedAt: null,
    errorReason: null,
    supersededBy: null,
    ...overrides,
  }
}

describe('describeStatus — 五态展示', () => {
  it('armed', () => {
    expect(describeStatus('armed')).toEqual({ tone: 'ok', label: '运行中' })
  })
  it('disabled', () => {
    expect(describeStatus('disabled')).toEqual({ tone: 'muted', label: '已停用' })
  })
  it('suspended', () => {
    expect(describeStatus('suspended')).toEqual({ tone: 'warn', label: '已静默' })
  })
  it('completed', () => {
    expect(describeStatus('completed')).toEqual({ tone: 'done', label: '已完成' })
  })
  it('error', () => {
    expect(describeStatus('error')).toEqual({ tone: 'danger', label: '异常' })
  })
})

describe('describeElapsed — 过去时刻', () => {
  it('从未发生 → 从未', () => {
    expect(describeElapsed(null, NOW)).toBe('从未')
  })

  it('不足一分钟 → 刚刚', () => {
    expect(describeElapsed(NOW - 30_000, NOW)).toBe('刚刚')
  })

  it('分钟级', () => {
    expect(describeElapsed(NOW - 12 * MIN, NOW)).toBe('12分钟前')
  })

  it('小时级', () => {
    expect(describeElapsed(NOW - 3 * HOUR, NOW)).toBe('3小时前')
  })

  it('跨天', () => {
    expect(describeElapsed(NOW - 2 * DAY, NOW)).toBe('2天前')
  })
})

describe('describeEta — 未来时刻', () => {
  it('没有下一次 → 破折号', () => {
    expect(describeEta(null, NOW)).toBe('—')
  })

  it('已过期（在未来之前）→ 即将', () => {
    expect(describeEta(NOW - 5_000, NOW)).toBe('即将')
  })

  it('分钟级', () => {
    expect(describeEta(NOW + 25 * MIN, NOW)).toBe('25分钟后')
  })

  it('小时级', () => {
    expect(describeEta(NOW + 3 * HOUR, NOW)).toBe('3小时后')
  })

  it('跨天', () => {
    expect(describeEta(NOW + DAY + 2 * HOUR, NOW)).toBe('1天2小时后')
  })
})

describe('explainError — 把内部原因翻译成人话', () => {
  it('已知原因给出解释', () => {
    expect(explainError('once-expired')).toContain('已过')
    expect(explainError('session-not-found')).toContain('会话')
    expect(explainError('subagent-session')).toContain('子 Agent')
    expect(explainError('not-root')).toContain('主 Agent')
  })

  it('未知原因原样返回（不隐藏信息）', () => {
    expect(explainError('some/internal-issue')).toBe('some/internal-issue')
  })

  it('空原因 → null', () => {
    expect(explainError(null)).toBeNull()
  })
})

describe('describeNoReply', () => {
  it('max = 0 表示关闭自动静默', () => {
    expect(describeNoReply(0, 0)).toBe('不静默')
  })

  it('正常显示 已累计/上限', () => {
    expect(describeNoReply(0, 3)).toBe('0/3')
    expect(describeNoReply(2, 3)).toBe('2/3')
  })
})

describe('toTaskRowView — 列表行', () => {
  it('正常任务：状态、下次触发、计数都渲染好', () => {
    const row = toTaskRowView(snapshot(), NOW, 3)

    expect(row.id).toBe('daily')
    expect(row.name).toBe('早间问候')
    expect(row.status).toEqual({ tone: 'ok', label: '运行中' })
    expect(row.nextFireText).toBe('30分钟后')
    expect(row.lastFiredText).toBe('1天前')
    expect(row.fireCountText).toBe('3')
    expect(row.noReplyText).toBe('0/3')
    expect(row.notice).toBeNull()
  })

  it('error：notice 是翻译后的原因，而不是原始 code', () => {
    const row = toTaskRowView(snapshot({ status: 'error', errorReason: 'session-not-found' }), NOW, 3)
    expect(row.status.tone).toBe('danger')
    expect(row.notice).toContain('会话')
  })

  it('suspended：notice 给出手动恢复提示', () => {
    const row = toTaskRowView(
      snapshot({
        status: 'suspended',
        suspendReason: '连续 3 次无回应，已自动静默',
        noReplyStreak: 3,
      }),
      NOW,
      3,
    )
    expect(row.status.tone).toBe('warn')
    expect(row.notice).toContain('连续 3 次无回应')
    expect(row.notice).toContain('回复')
  })

  it('FR-8 抑制：状态仍是运行中，但 notice 解释为什么没触发', () => {
    const row = toTaskRowView(snapshot({ nextFireAt: null, supersededBy: 'agent-busy' }), NOW, 3)

    expect(row.status).toEqual({ tone: 'ok', label: '运行中' })
    expect(row.nextFireText).toBe('—')
    expect(row.notice).toContain('模型')
  })

  it('notice 优先级：error > suspended > superseded', () => {
    const row = toTaskRowView(
      snapshot({
        status: 'error',
        errorReason: 'once-expired',
        suspendReason: '旧静默原因',
        supersededBy: 'agent-busy',
      }),
      NOW,
      3,
    )
    expect(row.notice).toContain('已过')
  })

  it('nextFireAt 为 null 且未被抑制 → 破折号，也没有 notice', () => {
    const row = toTaskRowView(snapshot({ status: 'disabled', nextFireAt: null }), NOW, 3)
    expect(row.nextFireText).toBe('—')
    expect(row.notice).toBeNull()
  })

  it('once 已完成 → 状态标签正确', () => {
    const row = toTaskRowView(snapshot({ status: 'completed', nextFireAt: null }), NOW, 3)
    expect(row.status.label).toBe('已完成')
  })
})
