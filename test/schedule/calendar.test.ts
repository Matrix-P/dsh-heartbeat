import { describe, expect, it } from 'vitest'

import type { DaySelectorInput } from '../../src/schedule/calendar.js'
import {
  ALL_DAYS,
  DaySelectorError,
  matchesDay,
  parseDaySelector,
  shiftDate,
  toDateKey,
  weekdayOf,
  WEEKENDS,
  WORKDAYS,
} from '../../src/schedule/calendar.js'

/**
 * 模拟手写 YAML 里的非法取值：故意绕过类型，验证运行时的校验分支。
 * 类型层面已排除这些输入，所以必须显式标注这是「越界测试」。
 */
const raw = (value: string): DaySelectorInput => value as DaySelectorInput

describe('parseDaySelector — 快捷值', () => {
  it('未设置 → 全部 7 天', () => {
    expect(parseDaySelector(undefined)).toEqual(ALL_DAYS)
  })

  it('all → 全部 7 天（0=周日 … 6=周六）', () => {
    expect(parseDaySelector('all')).toEqual([0, 1, 2, 3, 4, 5, 6])
  })

  it('workdays → 周一至周五', () => {
    expect(parseDaySelector('workdays')).toEqual([1, 2, 3, 4, 5])
    expect(WORKDAYS).toEqual([1, 2, 3, 4, 5])
  })

  it('weekends → 周六与周日', () => {
    expect(parseDaySelector('weekends')).toEqual([0, 6])
    expect(WEEKENDS).toEqual([0, 6])
  })

  it('快捷值忽略大小写与首尾空白', () => {
    expect(parseDaySelector(raw('  WorkDays  '))).toEqual([1, 2, 3, 4, 5])
  })
})

describe('parseDaySelector — 显式数组', () => {
  it('三条短名', () => {
    expect(parseDaySelector(['mon', 'wed', 'fri'])).toEqual([1, 3, 5])
  })

  it('结果按星期顺序排序（与输入顺序无关）', () => {
    expect(parseDaySelector(['fri', 'mon', 'wed'])).toEqual([1, 3, 5])
  })

  it('去重', () => {
    expect(parseDaySelector(['mon', 'mon', 'wed'])).toEqual([1, 3])
  })

  it('可与快捷值混用', () => {
    expect(parseDaySelector(['workdays', 'sun'])).toEqual([0, 1, 2, 3, 4, 5])
  })

  it('单元素', () => {
    expect(parseDaySelector(['sun'])).toEqual([0])
  })

  it('忽略大小写与首尾空白', () => {
    expect(parseDaySelector([' MON ', 'Wed'])).toEqual([1, 3])
  })
})

describe('parseDaySelector — 非法输入', () => {
  it('空数组是配置错误（不能静默当成 all）', () => {
    expect(() => parseDaySelector([])).toThrow(DaySelectorError)
  })

  it('未知短名', () => {
    expect(() => parseDaySelector(['monday'])).toThrow(DaySelectorError)
    expect(() => parseDaySelector(['mon', 'xxx'])).toThrow(DaySelectorError)
  })

  it('拼错的快捷值（workday 少 s）', () => {
    expect(() => parseDaySelector(raw('workday'))).toThrow(DaySelectorError)
  })

  it('非数组非字符串', () => {
    expect(() => parseDaySelector(3 as unknown as 'all')).toThrow(DaySelectorError)
  })

  it('错误信息里带上原始输入', () => {
    expect(() => parseDaySelector(['monday'])).toThrow(/monday/)
  })
})

describe('matchesDay', () => {
  it('workdays 命中周一至周五，不命中周末', () => {
    const selector = parseDaySelector('workdays')
    expect(matchesDay(1, selector)).toBe(true)
    expect(matchesDay(5, selector)).toBe(true)
    expect(matchesDay(0, selector)).toBe(false)
    expect(matchesDay(6, selector)).toBe(false)
  })

  it('weekends 命中周六与周日', () => {
    const selector = parseDaySelector('weekends')
    expect(matchesDay(0, selector)).toBe(true)
    expect(matchesDay(6, selector)).toBe(true)
    expect(matchesDay(3, selector)).toBe(false)
  })

  it('all 命中任意一天', () => {
    const selector = parseDaySelector('all')
    for (const day of ALL_DAYS) expect(matchesDay(day, selector)).toBe(true)
  })
})

describe('weekdayOf', () => {
  it('2026-09-21 是周一', () => {
    expect(weekdayOf({ year: 2026, month: 9, day: 21 })).toBe(1)
  })

  it('2026-09-20 是周日', () => {
    expect(weekdayOf({ year: 2026, month: 9, day: 20 })).toBe(0)
  })

  it('1970-01-01 是周四（Unix 纪元基准）', () => {
    expect(weekdayOf({ year: 1970, month: 1, day: 1 })).toBe(4)
  })

  it('2000-01-01 是周六', () => {
    expect(weekdayOf({ year: 2000, month: 1, day: 1 })).toBe(6)
  })

  it('与 zonedParts 的 weekday 口径一致（需求：0 = 周日）', () => {
    expect(weekdayOf({ year: 2026, month: 3, day: 8 })).toBe(0) // 美国夏令时切换日
    expect(weekdayOf({ year: 2026, month: 11, day: 1 })).toBe(0)
  })
})

describe('shiftDate — 纯日历推算', () => {
  it('同月内前进', () => {
    expect(shiftDate({ year: 2026, month: 9, day: 20 }, 1)).toEqual({ year: 2026, month: 9, day: 21 })
  })

  it('跨月', () => {
    expect(shiftDate({ year: 2026, month: 9, day: 30 }, 1)).toEqual({ year: 2026, month: 10, day: 1 })
  })

  it('跨年（向前）', () => {
    expect(shiftDate({ year: 2026, month: 12, day: 31 }, 1)).toEqual({ year: 2027, month: 1, day: 1 })
  })

  it('跨年（向后）', () => {
    expect(shiftDate({ year: 2027, month: 1, day: 1 }, -1)).toEqual({ year: 2026, month: 12, day: 31 })
  })

  it('闰年 2 月 29 日存在', () => {
    expect(shiftDate({ year: 2024, month: 2, day: 28 }, 1)).toEqual({ year: 2024, month: 2, day: 29 })
    expect(shiftDate({ year: 2024, month: 2, day: 29 }, 1)).toEqual({ year: 2024, month: 3, day: 1 })
  })

  it('平年 2 月直接跳到 3 月', () => {
    expect(shiftDate({ year: 2026, month: 2, day: 28 }, 1)).toEqual({ year: 2026, month: 3, day: 1 })
  })

  it('世纪闰年规则：1900 非闰、2000 是闰', () => {
    expect(shiftDate({ year: 1900, month: 2, day: 28 }, 1)).toEqual({ year: 1900, month: 3, day: 1 })
    expect(shiftDate({ year: 2000, month: 2, day: 28 }, 1)).toEqual({ year: 2000, month: 2, day: 29 })
  })

  it('大跨度：+365 天', () => {
    expect(shiftDate({ year: 2026, month: 1, day: 1 }, 365)).toEqual({ year: 2027, month: 1, day: 1 })
  })

  it('偏移 0 天不改变日期', () => {
    expect(shiftDate({ year: 2026, month: 9, day: 21 }, 0)).toEqual({ year: 2026, month: 9, day: 21 })
  })
})

describe('toDateKey', () => {
  it('补零成 YYYY-MM-DD，可用于日期比较与去重', () => {
    expect(toDateKey({ year: 2026, month: 9, day: 1 })).toBe('2026-09-01')
    expect(toDateKey({ year: 2026, month: 12, day: 31 })).toBe('2026-12-31')
  })
})
