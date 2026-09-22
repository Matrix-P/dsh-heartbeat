import { describe, expect, it } from 'vitest'

import {
  formatZoned,
  normalizeZone,
  systemTimeZone,
  validateTimeFormat,
  ZoneError,
  zonedInstant,
  zonedParts,
} from '../../src/schedule/zone.js'

/** 2026-09-21T00:00:00Z —— 该时刻在上海是 09-21 08:00（周一） */
const SEPT_21_UTC_MIDNIGHT = Date.UTC(2026, 8, 21, 0, 0, 0)

describe('zonedParts — Asia/Shanghai（UTC+8，无夏令时）', () => {
  const tz = 'Asia/Shanghai'

  it('拆出墙上时间各分量', () => {
    expect(zonedParts(SEPT_21_UTC_MIDNIGHT, tz)).toEqual({
      year: 2026,
      month: 9,
      day: 21,
      hour: 8,
      minute: 0,
      second: 0,
      weekday: 1,
      offsetMinutes: 480,
    })
  })

  it('跨日：UTC 前一天 16:00 对应上海次日 00:00', () => {
    expect(zonedParts(Date.UTC(2026, 8, 20, 16, 0, 0), tz)).toMatchObject({
      year: 2026,
      month: 9,
      day: 21,
      hour: 0,
      minute: 0,
    })
  })

  it('秒级精度', () => {
    expect(zonedParts(Date.UTC(2026, 8, 21, 0, 0, 37), tz).second).toBe(37)
  })
})

describe('zonedParts — weekday 编号（0 = 周日）', () => {
  const tz = 'Asia/Shanghai'

  it('周日 = 0（2026-09-20）', () => {
    expect(zonedParts(Date.UTC(2026, 8, 20, 4, 0, 0), tz).weekday).toBe(0)
  })

  it('周一 = 1（2026-09-21）', () => {
    expect(zonedParts(SEPT_21_UTC_MIDNIGHT, tz).weekday).toBe(1)
  })

  it('周六 = 6（2026-09-26）', () => {
    expect(zonedParts(Date.UTC(2026, 8, 26, 4, 0, 0), tz).weekday).toBe(6)
  })
})

describe('zonedParts — America/New_York 夏令时偏移', () => {
  const tz = 'America/New_York'

  it('冬季为 EST（UTC-5）', () => {
    expect(zonedParts(Date.UTC(2026, 0, 15, 12, 0, 0), tz)).toMatchObject({
      hour: 7,
      offsetMinutes: -300,
    })
  })

  it('夏季为 EDT（UTC-4）', () => {
    expect(zonedParts(Date.UTC(2026, 6, 15, 12, 0, 0), tz)).toMatchObject({
      hour: 8,
      offsetMinutes: -240,
    })
  })
})

describe('zonedInstant — 墙上时间反解为绝对时刻', () => {
  it('上海：墙上 08:00 → 00:00Z', () => {
    expect(
      zonedInstant(
        { year: 2026, month: 9, day: 21, hour: 8, minute: 0, second: 0 },
        'Asia/Shanghai',
      ),
    ).toBe(SEPT_21_UTC_MIDNIGHT)
  })

  it('夏令时开始：不存在的墙上时刻（2026-03-08 02:30）抛错', () => {
    expect(() =>
      zonedInstant(
        { year: 2026, month: 3, day: 8, hour: 2, minute: 30, second: 0 },
        'America/New_York',
      ),
    ).toThrow(ZoneError)
  })

  it('夏令时结束：重复的墙上时刻（2026-11-01 01:30）取较早的一次', () => {
    expect(
      zonedInstant(
        { year: 2026, month: 11, day: 1, hour: 1, minute: 30, second: 0 },
        'America/New_York',
      ),
    ).toBe(Date.UTC(2026, 10, 1, 5, 30, 0))
  })

  it('往返一致（含夏令时切换点两侧，排除模糊小时内部）', () => {
    const tz = 'America/New_York'
    const instants = [
      '2026-01-15T12:00:00Z',
      '2026-03-08T06:59:00Z', // 切换前 1 分钟（EST）
      '2026-03-08T07:00:00Z', // 切换瞬间（EDT）
      '2026-07-15T12:00:00Z',
      '2026-11-01T05:30:00Z', // 模糊小时，取较早者恰好等于它自己
    ]

    for (const iso of instants) {
      const t = Date.parse(iso)
      const p = zonedParts(t, tz)
      expect(
        zonedInstant(
          { year: p.year, month: p.month, day: p.day, hour: p.hour, minute: p.minute, second: p.second },
          tz,
        ),
        `往返失败：${iso}`,
      ).toBe(t)
    }
  })
})

describe('normalizeZone', () => {
  it('保留合法时区名', () => {
    expect(normalizeZone('Asia/Shanghai', 'UTC')).toBe('Asia/Shanghai')
  })

  it('规范化大小写', () => {
    expect(normalizeZone('asia/shanghai', 'UTC')).toBe('Asia/Shanghai')
  })

  it('UTC 合法', () => {
    expect(normalizeZone('UTC', 'Asia/Shanghai')).toBe('UTC')
  })

  it('忽略首尾空白后仍合法', () => {
    expect(normalizeZone('  Asia/Shanghai  ', 'UTC')).toBe('Asia/Shanghai')
  })

  it('空串 / 纯空白 / undefined → 用回退值', () => {
    expect(normalizeZone('', 'Asia/Shanghai')).toBe('Asia/Shanghai')
    expect(normalizeZone('   ', 'Asia/Shanghai')).toBe('Asia/Shanghai')
    expect(normalizeZone(undefined, 'Asia/Shanghai')).toBe('Asia/Shanghai')
  })

  it('非法时区名抛错，不静默回退（便于配置校验一次性报出）', () => {
    expect(() => normalizeZone('Not/AZone', 'UTC')).toThrow(ZoneError)
    expect(() => normalizeZone('Foo/Bar', 'UTC')).toThrow(ZoneError)
  })

  it('接受 ES2023 的偏移时区（+08:00）并原样规范化返回', () => {
    // Intl 自 ES2023 起支持偏移时区，这里不加人为限制，如实记录平台行为。
    expect(normalizeZone('+08:00', 'UTC')).toBe('+08:00')
    expect(zonedParts(SEPT_21_UTC_MIDNIGHT, '+08:00').hour).toBe(8)
  })
})

describe('systemTimeZone', () => {
  it('返回一个非空的合法时区名', () => {
    const tz = systemTimeZone()
    expect(tz.length).toBeGreaterThan(0)
    expect(normalizeZone(tz, 'UTC')).toBe(tz)
  })
})

describe('formatZoned — 时间格式串', () => {
  const tz = 'Asia/Shanghai'

  it('HH:mm', () => {
    expect(formatZoned(SEPT_21_UTC_MIDNIGHT, tz, 'HH:mm')).toBe('08:00')
  })

  it('YYYY-MM-DD HH:mm:ss', () => {
    expect(formatZoned(SEPT_21_UTC_MIDNIGHT, tz, 'YYYY-MM-DD HH:mm:ss')).toBe('2026-09-21 08:00:00')
  })

  it('个位数不补零（M / D / H / m / s）', () => {
    expect(formatZoned(Date.UTC(2026, 8, 1, 0, 5, 7), tz, 'M/D H:m:s')).toBe('9/1 8:5:7')
  })

  it('秒补零', () => {
    expect(formatZoned(Date.UTC(2026, 8, 21, 0, 0, 5), tz, 'HH:mm:ss')).toBe('08:00:05')
  })

  it('非 token 字符原样保留（含中文）', () => {
    expect(formatZoned(SEPT_21_UTC_MIDNIGHT, tz, 'YYYY年MM月DD日 HH时mm分')).toBe(
      '2026年09月21日 08时00分',
    )
  })

  it('无法识别的字母串原样输出，不会被吞掉', () => {
    expect(formatZoned(SEPT_21_UTC_MIDNIGHT, tz, 'QQ-HH')).toBe('QQ-08')
  })
})

describe('formatZoned — 方括号转义（[] 内按字面输出）', () => {
  const tz = 'Asia/Shanghai'

  it('ISO 风格的 T 字面量', () => {
    expect(formatZoned(SEPT_21_UTC_MIDNIGHT, tz, 'YYYY-MM-DD[T]HH:mm:ss')).toBe(
      '2026-09-21T08:00:00',
    )
  })

  it('方括号内可放任意文本', () => {
    expect(formatZoned(SEPT_21_UTC_MIDNIGHT, tz, 'HH点[HH]mm分')).toBe('08点HH00分')
  })

  it('未闭合的方括号按字面输出（由 validateTimeFormat 负责报错）', () => {
    expect(formatZoned(SEPT_21_UTC_MIDNIGHT, tz, 'HH[mm')).toBe('08[00')
  })
})

describe('validateTimeFormat — 加载期静态校验（FR-7 第 6 条）', () => {
  it('全部合法 token', () => {
    expect(validateTimeFormat('YYYY-MM-DD HH:mm:ss')).toBeNull()
    expect(validateTimeFormat('HH:mm')).toBeNull()
    expect(validateTimeFormat('M/D H:m:s')).toBeNull()
  })

  it('允许非 ASCII 字母（中文）作为字面量', () => {
    expect(validateTimeFormat('YYYY年MM月DD日 HH时mm分')).toBeNull()
  })

  it('允许方括号转义', () => {
    expect(validateTimeFormat('YYYY-MM-DD[T]HH:mm:ss')).toBeNull()
  })

  it('拒绝小写 hh（常见的 12/24 小时笔误）', () => {
    expect(validateTimeFormat('hh:mm')).toMatch(/hh/)
  })

  it('拒绝不认识的字母串与裸 T', () => {
    expect(validateTimeFormat('QQ')).not.toBeNull()
    expect(validateTimeFormat('YYYY-MM-DDTHH:mm')).not.toBeNull()
  })

  it('拒绝空格式串', () => {
    expect(validateTimeFormat('')).not.toBeNull()
  })

  it('拒绝未闭合的方括号', () => {
    expect(validateTimeFormat('YYYY-MM-DD[T')).not.toBeNull()
  })

  it('至少要有一个有效 token（纯字面量没有意义）', () => {
    expect(validateTimeFormat('年月日')).not.toBeNull()
  })
})
