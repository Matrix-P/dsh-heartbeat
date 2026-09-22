import { describe, expect, it } from 'vitest'

import { parseDuration, parseIntervalDuration } from '../../src/schedule/duration.js'

describe('parseDuration — 合法输入', () => {
  it('解析秒', () => {
    expect(parseDuration('90s')).toBe(90_000)
  })

  it('解析分钟', () => {
    expect(parseDuration('30m')).toBe(1_800_000)
  })

  it('解析小时', () => {
    expect(parseDuration('2h')).toBe(7_200_000)
  })

  it('解析 1 分钟', () => {
    expect(parseDuration('1m')).toBe(60_000)
  })

  it('忽略首尾空白', () => {
    expect(parseDuration('  30m  ')).toBe(1_800_000)
  })

  it('接受大数值（48 小时）', () => {
    expect(parseDuration('48h')).toBe(172_800_000)
  })
})

describe('parseDuration — 非法输入', () => {
  const invalid: Array<[label: string, text: string]> = [
    ['空字符串', ''],
    ['只有空白', '   '],
    ['缺单位', '30'],
    ['未知单位', '30x'],
    ['大写单位', '30M'],
    ['负数', '-5m'],
    ['零', '0m'],
    ['小数', '1.5h'],
    ['单位与数字之间有空格', '30 m'],
    ['顺序颠倒', 'm30'],
    ['复合单位', '1h30m'],
    ['纯字母', 'abcm'],
  ]

  it.each(invalid)('拒绝：%s', (_label, text) => {
    expect(() => parseDuration(text)).toThrow()
  })

  it('错误信息里带上原始输入，便于定位', () => {
    expect(() => parseDuration('30x')).toThrow(/30x/)
  })
})

describe('parseIntervalDuration — 间隔最小 1 分钟（FR-2 第 1 条）', () => {
  it('60s 恰好 1 分钟 → 允许', () => {
    expect(parseIntervalDuration('60s')).toBe(60_000)
  })

  it('90s 达到 1 分钟以上 → 允许', () => {
    expect(parseIntervalDuration('90s')).toBe(90_000)
  })

  it('1m → 允许', () => {
    expect(parseIntervalDuration('1m')).toBe(60_000)
  })

  it('30m → 允许', () => {
    expect(parseIntervalDuration('30m')).toBe(1_800_000)
  })

  it('59s 亚分钟 → 拒绝', () => {
    expect(() => parseIntervalDuration('59s')).toThrow()
  })

  it('30s 亚分钟 → 拒绝', () => {
    expect(() => parseIntervalDuration('30s')).toThrow()
  })

  it('格式非法时同样抛错（不会静默返回）', () => {
    expect(() => parseIntervalDuration('abc')).toThrow()
  })
})
