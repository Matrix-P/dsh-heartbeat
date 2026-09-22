import { describe, expect, it } from 'vitest'

import type { DaySelectorInput } from '../../src/schedule/calendar.js'
import { parseDaySelector } from '../../src/schedule/calendar.js'
import type { NextFireInput, NormalizedSchedule } from '../../src/schedule/next-fire.js'
import { nextFireAfter, ScheduleError } from '../../src/schedule/next-fire.js'

const TZ = 'Asia/Shanghai'
const HOUR = 3_600_000
const MIN = 60_000

/** 2026-09-21T00:00:00Z —— 上海 09-21 08:00（周一） */
const MON_0800 = Date.UTC(2026, 8, 21, 0, 0, 0)

function input(
  schedule: NormalizedSchedule,
  overrides: Partial<NextFireInput> = {},
): NextFireInput {
  return {
    schedule,
    timezone: TZ,
    now: MON_0800,
    anchorAt: null,
    lastFiredAt: null,
    lastIdleAt: null,
    agentBusy: false,
    ...overrides,
  }
}

const interval30 = (anchor: 'enable-time' | 'interval-end' = 'enable-time'): NormalizedSchedule => ({
  kind: 'interval',
  everyMs: 30 * MIN,
  anchor,
})

describe('interval — FR-8 核心公式：base = lastIdleAt ?? anchorAt', () => {
  it('模型刚说完 → 下次触发 = 说完时刻 + every', () => {
    expect(
      nextFireAfter(input(interval30(), { now: MON_0800, lastIdleAt: MON_0800, anchorAt: MON_0800 - 10 * HOUR })),
    ).toBe(MON_0800 + 30 * MIN)
  })

  it('模型说过话后，anchorAt 不再决定落点（T22 精神）', () => {
    // anchorAt 落在 08:00 的整点上，但模型 08:07 才说完 → 下一次是 08:37，而不是 08:30
    const anchorAt = MON_0800
    const lastIdleAt = MON_0800 + 7 * MIN
    expect(nextFireAfter(input(interval30(), { now: lastIdleAt, anchorAt, lastIdleAt }))).toBe(
      MON_0800 + 37 * MIN,
    )
  })

  it('模型从未说话（lastIdleAt = null）→ 回落 anchorAt', () => {
    expect(
      nextFireAfter(input(interval30('enable-time'), { now: MON_0800, anchorAt: MON_0800, lastIdleAt: null })),
    ).toBe(MON_0800 + 30 * MIN)
  })

  it('anchor = interval-end 且从未说话 → 以 lastFiredAt 为基准', () => {
    expect(
      nextFireAfter(
        input(interval30('interval-end'), {
          now: MON_0800,
          anchorAt: MON_0800 - HOUR,
          lastFiredAt: MON_0800 - 10 * MIN,
          lastIdleAt: null,
        }),
      ),
    ).toBe(MON_0800 + 20 * MIN)
  })

  it('anchor = interval-end 且从未触发过 → 回落到 anchorAt', () => {
    expect(
      nextFireAfter(
        input(interval30('interval-end'), {
          now: MON_0800,
          anchorAt: MON_0800,
          lastFiredAt: null,
          lastIdleAt: null,
        }),
      ),
    ).toBe(MON_0800 + 30 * MIN)
  })

  it('lastIdleAt 在 anchorAt 之后时优先采用 lastIdleAt', () => {
    expect(
      nextFireAfter(
        input(interval30(), { now: MON_0800, anchorAt: MON_0800, lastIdleAt: MON_0800 + 5 * MIN }),
      ),
    ).toBe(MON_0800 + 35 * MIN)
  })

  it('FR-5 恢复：anchorAt 晚于 lastFiredAt 时以恢复时刻为基准（interval-end）', () => {
    // 08:00 触发过，09:20 用户回复（anchorAt = 09:20）→ 下一次是 09:50，而不是按 08:00 的旧网格（09:30）
    const anchorAt = MON_0800 + 80 * MIN
    const lastFiredAt = MON_0800
    expect(
      nextFireAfter(
        input(interval30('interval-end'), { now: anchorAt, anchorAt, lastFiredAt, lastIdleAt: null }),
      ),
    ).toBe(anchorAt + 30 * MIN)
  })
})

describe('interval — 取整与陈旧基准', () => {
  it('now 不落在 base 的整数倍上时向上取到下一个倍数', () => {
    // base = 08:00，every = 30min，now = 08:16:40 → 下一次应为 08:30
    expect(
      nextFireAfter(input(interval30(), { now: MON_0800 + 16 * MIN + 40_000, anchorAt: MON_0800, lastIdleAt: MON_0800 })),
    ).toBe(MON_0800 + 30 * MIN)
  })

  it('基准很旧时按绝对时间轴跳到 now 之后（不逐次补发）', () => {
    // base = 4 小时前，every = 30min，now = 08:01 → 下一格是 08:30
    const base = MON_0800 - 4 * HOUR
    expect(nextFireAfter(input(interval30(), { now: MON_0800 + MIN, anchorAt: base, lastIdleAt: base }))).toBe(
      MON_0800 + 30 * MIN,
    )
  })

  it('结果严格大于 now（不会返回 base 自身）', () => {
    const result = nextFireAfter(input(interval30(), { now: MON_0800, anchorAt: MON_0800, lastIdleAt: MON_0800 }))
    expect(result).toBeGreaterThan(MON_0800)
  })

  it('两个基准都缺失 → 抛 ScheduleError（启用中的任务必有 anchorAt）', () => {
    expect(() => nextFireAfter(input(interval30(), { anchorAt: null, lastIdleAt: null }))).toThrow(ScheduleError)
  })
})

describe('FR-8 输出抑制（agentBusy）', () => {
  it('间隔类：模型正在输出 → 返回 null（本次不触发）', () => {
    expect(
      nextFireAfter(input(interval30(), { now: MON_0800, anchorAt: MON_0800, lastIdleAt: MON_0800, agentBusy: true })),
    ).toBeNull()
  })

  it('窗口间隔类：模型正在输出 → 返回 null', () => {
    const schedule: NormalizedSchedule = {
      kind: 'windowed-interval',
      everyMs: 30 * MIN,
      days: parseDaySelector('workdays'),
      startMinute: 8 * 60,
      endMinute: 16 * 60,
      align: 'window-start',
    }
    expect(nextFireAfter(input(schedule, { now: MON_0800, agentBusy: true }))).toBeNull()
  })

  it('daily：模型正在输出不影响绝对时刻（FR-8 不适用于固定时刻类）', () => {
    const schedule: NormalizedSchedule = { kind: 'daily', timeOfDay: 9 * 60 }
    expect(nextFireAfter(input(schedule, { now: MON_0800, agentBusy: true }))).toBe(MON_0800 + HOUR)
  })

  it('weekly：模型正在输出不影响绝对时刻', () => {
    const schedule: NormalizedSchedule = {
      kind: 'weekly',
      timeOfDay: 9 * 60,
      days: parseDaySelector(['mon']),
    }
    expect(nextFireAfter(input(schedule, { now: MON_0800, agentBusy: true }))).toBe(MON_0800 + HOUR)
  })
})

describe('daily', () => {
  const schedule: NormalizedSchedule = { kind: 'daily', timeOfDay: 9 * 60 }

  it('今天还没到 → 今天的该时刻', () => {
    // now = 上海 08:00，目标 09:00 → 上海 09:00 = 01:00Z
    expect(nextFireAfter(input(schedule))).toBe(MON_0800 + HOUR)
  })

  it('今天的时刻已过 → 明天同一时刻', () => {
    const eight = { kind: 'daily', timeOfDay: 8 * 60 } as const
    expect(nextFireAfter(input(eight, { now: MON_0800 }))).toBe(MON_0800 + 24 * HOUR)
  })

  it('恰好等于 now → 顺延到明天（严格大于 now）', () => {
    const eight = { kind: 'daily', timeOfDay: 8 * 60 } as const
    expect(nextFireAfter(input(eight, { now: MON_0800 }))).toBe(MON_0800 + 24 * HOUR)
  })

  it('按任务时区求值（America/New_York 冬季）', () => {
    // now = 2026-01-15T12:00:00Z = 纽约 07:00 EST，目标 08:00 → 13:00Z
    const ny: NormalizedSchedule = { kind: 'daily', timeOfDay: 8 * 60 }
    expect(
      nextFireAfter(
        input(ny, { timezone: 'America/New_York', now: Date.UTC(2026, 0, 15, 12, 0, 0) }),
      ),
    ).toBe(Date.UTC(2026, 0, 15, 13, 0, 0))
  })

  it('夏令时跳变造成墙上时刻不存在 → 顺延到间隙之后的第一个有效时刻', () => {
    // 纽约 2026-03-08 02:30 不存在（01:59 EST 直接跳到 03:00 EDT）
    // now = 2026-03-08T00:00:00Z = 纽约 03-07 19:00 → 期望 07:00Z = 03:00 EDT
    const ny: NormalizedSchedule = { kind: 'daily', timeOfDay: 2 * 60 + 30 }
    expect(
      nextFireAfter(
        input(ny, { timezone: 'America/New_York', now: Date.UTC(2026, 2, 8, 0, 0, 0) }),
      ),
    ).toBe(Date.UTC(2026, 2, 8, 7, 0, 0))
  })
})

describe('weekly', () => {
  it('今天是命中日且时刻未到 → 今天', () => {
    const schedule: NormalizedSchedule = {
      kind: 'weekly',
      timeOfDay: 9 * 60,
      days: parseDaySelector(['mon']),
    }
    expect(nextFireAfter(input(schedule))).toBe(MON_0800 + HOUR)
  })

  it('今天是命中日但时刻已过 → 下一个命中日（下周一）', () => {
    const schedule: NormalizedSchedule = {
      kind: 'weekly',
      timeOfDay: 9 * 60,
      days: parseDaySelector(['mon']),
    }
    // now = 上海 周一 10:00 = 02:00Z
    expect(nextFireAfter(input(schedule, { now: MON_0800 + 2 * HOUR }))).toBe(
      Date.UTC(2026, 8, 28, 1, 0, 0),
    )
  })

  it('workdays：周五收盘后跳到下周一', () => {
    const schedule: NormalizedSchedule = {
      kind: 'weekly',
      timeOfDay: 9 * 60,
      days: parseDaySelector('workdays'),
    }
    // now = 上海 周五 17:00 = 2026-09-25T09:00:00Z
    expect(nextFireAfter(input(schedule, { now: Date.UTC(2026, 8, 25, 9, 0, 0) }))).toBe(
      Date.UTC(2026, 8, 28, 1, 0, 0),
    )
  })

  it('workdays：周六不会触发，落到下周一', () => {
    const schedule: NormalizedSchedule = {
      kind: 'weekly',
      timeOfDay: 9 * 60,
      days: parseDaySelector('workdays'),
    }
    // now = 上海 周六 10:00 = 2026-09-26T02:00:00Z
    expect(nextFireAfter(input(schedule, { now: Date.UTC(2026, 8, 26, 2, 0, 0) }))).toBe(
      Date.UTC(2026, 8, 28, 1, 0, 0),
    )
  })
})

describe('once', () => {
  it('尚未到期 → 返回到期时刻', () => {
    const schedule: NormalizedSchedule = { kind: 'once', at: MON_0800 + HOUR }
    expect(nextFireAfter(input(schedule))).toBe(MON_0800 + HOUR)
  })

  it('已过期 → 返回 null（由调用方区分"加载期过期"与"运行期错过"）', () => {
    const schedule: NormalizedSchedule = { kind: 'once', at: MON_0800 - HOUR }
    expect(nextFireAfter(input(schedule))).toBeNull()
  })

  it('恰好等于 now → 返回 null', () => {
    const schedule: NormalizedSchedule = { kind: 'once', at: MON_0800 }
    expect(nextFireAfter(input(schedule))).toBeNull()
  })
})

describe('windowed-interval — 窗口内对齐', () => {
  const workWindow = (align: 'window-start' | 'enable-time'): NormalizedSchedule => ({
    kind: 'windowed-interval',
    everyMs: 30 * MIN,
    days: parseDaySelector('workdays'),
    startMinute: 8 * 60,
    endMinute: 16 * 60,
    align,
  })

  it('align = window-start：窗口内按窗口起点对齐（T5 前置）', () => {
    // now = 上海 08:05 → 下一个候选 08:30 = 00:30Z
    expect(nextFireAfter(input(workWindow('window-start'), { now: MON_0800 + 5 * MIN }))).toBe(
      Date.UTC(2026, 8, 21, 0, 30, 0),
    )
  })

  it('端点左闭右闭：now 在 16:00 前一刻 → 仍选中 16:00 端点（T5）', () => {
    expect(
      nextFireAfter(input(workWindow('window-start'), { now: Date.UTC(2026, 8, 21, 7, 59, 59) })),
    ).toBe(Date.UTC(2026, 8, 21, 8, 0, 0))
  })

  it('窗口结束后不补发，落到下一个窗口起点', () => {
    // now = 上海 周一 16:30 = 08:30Z → 周二 08:00 = 2026-09-22T00:00:00Z
    expect(nextFireAfter(input(workWindow('window-start'), { now: Date.UTC(2026, 8, 21, 8, 30, 0) }))).toBe(
      Date.UTC(2026, 8, 22, 0, 0, 0),
    )
  })

  it('周五收盘后跳过周末，落到下周一窗口起点', () => {
    // now = 上海 周五 16:30 = 2026-09-25T08:30:00Z
    expect(nextFireAfter(input(workWindow('window-start'), { now: Date.UTC(2026, 8, 25, 8, 30, 0) }))).toBe(
      Date.UTC(2026, 8, 28, 0, 0, 0),
    )
  })

  it('align = enable-time：以任务启用时刻为基准对齐', () => {
    // anchorAt = 上海 08:10 = 00:10Z，every 30min → 候选 00:10Z / 00:40Z …
    expect(
      nextFireAfter(
        input(workWindow('enable-time'), { now: MON_0800 + 5 * MIN, anchorAt: MON_0800 + 10 * MIN }),
      ),
    ).toBe(MON_0800 + 10 * MIN)
  })

  it('lastIdleAt 优先于 align（FR-8 第 6 条）', () => {
    // 若走 window-start 会得到 08:30；模型 09:07 才说完 → 应为 09:07
    expect(
      nextFireAfter(
        input(workWindow('window-start'), {
          now: MON_0800 + 5 * MIN,
          anchorAt: MON_0800,
          lastIdleAt: MON_0800 + 67 * MIN,
        }),
      ),
    ).toBe(MON_0800 + 67 * MIN)
  })

  it('every 大于窗口长度 → 每个窗口只在起点触发一次', () => {
    const shortWindow: NormalizedSchedule = {
      kind: 'windowed-interval',
      everyMs: 30 * MIN,
      days: parseDaySelector('workdays'),
      startMinute: 8 * 60,
      endMinute: 8 * 60 + 10, // 窗口仅 10 分钟 < every
      align: 'window-start',
    }
    // now = 上海 周一 07:00 = 2026-09-20T23:00:00Z
    expect(nextFireAfter(input(shortWindow, { now: Date.UTC(2026, 8, 20, 23, 0, 0) }))).toBe(
      Date.UTC(2026, 8, 21, 0, 0, 0),
    )
  })
})

describe('windowed-interval — 跨零点窗口（T6）', () => {
  const overnight = (days: DaySelectorInput): NormalizedSchedule => ({
    kind: 'windowed-interval',
    everyMs: 30 * MIN,
    days: parseDaySelector(days),
    startMinute: 22 * 60,
    endMinute: 2 * 60,
    align: 'window-start',
  })

  it('周一 22:00–02:00：周一 23:00 时下一次是 23:30', () => {
    // 上海 周一 23:00 = 2026-09-21T15:00:00Z
    expect(nextFireAfter(input(overnight('all'), { now: Date.UTC(2026, 8, 21, 15, 0, 0) }))).toBe(
      Date.UTC(2026, 8, 21, 15, 30, 0),
    )
  })

  it('days 归属窗口起点所在日：days=[mon] 时周二凌晨仍属周一的窗口', () => {
    // now = 上海 周二 01:00 = 2026-09-21T17:00:00Z，仍在周一窗口内
    expect(
      nextFireAfter(input(overnight(['mon']), { now: Date.UTC(2026, 8, 21, 17, 0, 0) })),
    ).toBe(Date.UTC(2026, 8, 21, 17, 30, 0))
  })

  it('days=[tue] 时周一的窗口不被采用，落到周二的窗口', () => {
    // now = 上海 周一 23:00 = 15:00Z → 下一个窗口是周二 22:00 = 2026-09-22T14:00:00Z
    expect(
      nextFireAfter(input(overnight(['tue']), { now: Date.UTC(2026, 8, 21, 15, 0, 0) })),
    ).toBe(Date.UTC(2026, 8, 22, 14, 0, 0))
  })
})
