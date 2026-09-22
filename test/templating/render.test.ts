import { describe, expect, it } from 'vitest'

import { parseTemplate } from '../../src/templating/parse.js'
import type { RenderContext, Rng } from '../../src/templating/render.js'
import { describeDuration, renderTemplate } from '../../src/templating/render.js'

const TZ = 'Asia/Shanghai'
/** 上海 2026-09-21 08:00（周一） */
const NOW = Date.UTC(2026, 8, 21, 0, 0, 0)
const MIN = 60_000
const HOUR = 3_600_000

function fixedRng(value: number): Rng {
  return { int: () => value }
}

function context(overrides: Partial<RenderContext> = {}): RenderContext {
  return {
    now: NOW,
    timezone: TZ,
    task: {
      id: 'morning',
      name: '早间问候',
      fireCount: 12,
      noReplyStreak: 2,
      lastFiredAt: Date.UTC(2026, 8, 20, 0, 0, 0),
      nextFireAt: Date.UTC(2026, 8, 22, 0, 0, 0),
    },
    session: { lastUserMsgAt: null },
    rng: fixedRng(42),
    ...overrides,
  }
}

function render(text: string, ctx: RenderContext = context()): string {
  const parsed = parseTemplate(text)
  if (!parsed.ok) {
    throw new Error(`模板解析失败：${parsed.errors.map((e) => e.message).join(' / ')}`)
  }
  return renderTemplate(parsed.nodes, ctx)
}

describe('renderTemplate — 时间类变量', () => {
  it('{time} 默认格式 HH:mm', () => {
    expect(render('{time}')).toBe('08:00')
  })

  it('{time:HH:mm:ss} 按指定格式', () => {
    expect(render('{time:HH:mm:ss}')).toBe('08:00:00')
  })

  it('{date} 默认 YYYY-MM-DD', () => {
    expect(render('{date}')).toBe('2026-09-21')
  })

  it('{datetime} 默认 YYYY-MM-DD HH:mm', () => {
    expect(render('{datetime}')).toBe('2026-09-21 08:00')
  })

  it('{weekday} 输出中文星期', () => {
    expect(render('{weekday}')).toBe('周一')
  })

  it('{weekday} 周日', () => {
    expect(render('{weekday}', context({ now: Date.UTC(2026, 8, 20, 4, 0, 0) }))).toBe('周日')
  })

  it('按任务时区求值（同一时刻在纽约是前一天晚上）', () => {
    const ctx = context({ timezone: 'America/New_York', now: Date.UTC(2026, 8, 21, 0, 0, 0) })
    expect(render('{datetime}', ctx)).toBe('2026-09-20 20:00')
  })

  it('触发时求值：同一节点树在不同 now 下给出不同结果（FR-7 第 2 条）', () => {
    const parsed = parseTemplate('现在是{time}')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return

    expect(renderTemplate(parsed.nodes, context({ now: NOW }))).toBe('现在是08:00')
    expect(renderTemplate(parsed.nodes, context({ now: NOW + MIN }))).toBe('现在是08:01')
  })
})

describe('renderTemplate — 任务与会话类变量', () => {
  it('{taskId}', () => {
    expect(render('{taskId}')).toBe('morning')
  })

  it('{taskName}', () => {
    expect(render('{taskName}')).toBe('早间问候')
  })

  it('{taskName} 为空时回落到 id', () => {
    const ctx = context({ task: { ...context().task, name: '' } })
    expect(render('{taskName}', ctx)).toBe('morning')
  })

  it('{fireCount}', () => {
    expect(render('{fireCount}')).toBe('12')
  })

  it('{noReplyStreak}', () => {
    expect(render('{noReplyStreak}')).toBe('2')
  })

  it('{lastFiredAt} / {nextFireAt}', () => {
    expect(render('{lastFiredAt}')).toBe('2026-09-20 08:00')
    expect(render('{nextFireAt}')).toBe('2026-09-22 08:00')
  })

  it('{lastFiredAt} 从未触发 → 空串', () => {
    const ctx = context({ task: { ...context().task, lastFiredAt: null } })
    expect(render('A{lastFiredAt}B', ctx)).toBe('AB')
  })

  it('{nextFireAt} 非计时状态 → 空串', () => {
    const ctx = context({ task: { ...context().task, nextFireAt: null } })
    expect(render('A{nextFireAt}B', ctx)).toBe('AB')
  })

  it('{lastUserMsgAt} 从未发言 → 空串', () => {
    expect(render('A{lastUserMsgAt}B')).toBe('AB')
  })

  it('{lastUserMsgAt} 有值 → 按格式输出', () => {
    const ctx = context({ session: { lastUserMsgAt: Date.UTC(2026, 8, 21, 1, 30, 0) } })
    expect(render('{lastUserMsgAt}', ctx)).toBe('2026-09-21 09:30')
  })
})

describe('renderTemplate — {sinceLastUserMsg}', () => {
  it('从未发言 → 从未', () => {
    expect(render('{sinceLastUserMsg}')).toBe('从未')
  })

  it('3 小时 20 分钟前', () => {
    const ctx = context({ session: { lastUserMsgAt: NOW - (3 * HOUR + 20 * MIN) } })
    expect(render('{sinceLastUserMsg}', ctx)).toBe('3小时20分钟')
  })

  it('刚刚（不足 1 分钟）', () => {
    const ctx = context({ session: { lastUserMsgAt: NOW - 30_000 } })
    expect(render('{sinceLastUserMsg}', ctx)).toBe('刚刚')
  })
})

describe('renderTemplate — {random}（FR-7 第 10 条：随机源可注入）', () => {
  it('使用注入的随机源', () => {
    expect(render('{random}', context({ rng: fixedRng(7) }))).toBe('7')
  })

  it('默认范围 1-100', () => {
    const calls: Array<[number, number]> = []
    const rng: Rng = {
      int: (min, max) => {
        calls.push([min, max])
        return 1
      },
    }
    render('{random}', context({ rng }))
    expect(calls).toEqual([[1, 100]])
  })

  it('{random:5-9} 把范围透传给随机源', () => {
    const calls: Array<[number, number]> = []
    const rng: Rng = {
      int: (min, max) => {
        calls.push([min, max])
        return 7
      },
    }
    expect(render('{random:5-9}', context({ rng }))).toBe('7')
    expect(calls).toEqual([[5, 9]])
  })
})

describe('renderTemplate — 组合与转义', () => {
  it('多处占位符与中文混排', () => {
    expect(render('现在是{time}（{weekday}），距上次说话 {sinceLastUserMsg}')).toBe(
      '现在是08:00（周一），距上次说话 从未',
    )
  })

  it('{{time}} 输出字面量而非求值', () => {
    expect(render('{{time}}')).toBe('{time}')
  })

  it('空模板', () => {
    expect(render('')).toBe('')
  })
})

describe('describeDuration', () => {
  const cases: Array<[label: string, ms: number, expected: string]> = [
    ['0', 0, '刚刚'],
    ['59 秒', 59_000, '刚刚'],
    ['1 分钟', MIN, '1分钟'],
    ['59 分钟', 59 * MIN, '59分钟'],
    ['1 小时', HOUR, '1小时'],
    ['3 小时 20 分钟', 3 * HOUR + 20 * MIN, '3小时20分钟'],
    ['23 小时 59 分钟', 23 * HOUR + 59 * MIN, '23小时59分钟'],
    ['24 小时 → 1 天', 24 * HOUR, '1天'],
    ['25 小时 → 1 天 1 小时', 25 * HOUR, '1天1小时'],
    ['48 小时 → 2 天', 48 * HOUR, '2天'],
  ]

  it.each(cases)('%s', (_label, ms, expected) => {
    expect(describeDuration(ms)).toBe(expected)
  })

  it('负数（时钟回拨等异常）不产出乱码', () => {
    expect(describeDuration(-5_000)).toBe('刚刚')
  })
})
