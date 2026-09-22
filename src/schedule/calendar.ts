/**
 * 日历与星期选择器（技术设计 6.3 节的前置件）。
 *
 * 职责很窄：把配置里的 `days` 规范成 `Weekday[]`，并提供纯日历推算。
 * **不涉及时区**——时区相关的换算一律在 `zone.ts`；本模块只处理「年月日」。
 *
 * 纪律：不读时钟。允许 `Date.UTC(...)` 与带参数的 `new Date(ms)` 做纯日历运算，
 * 但**无参** `new Date()` / `Date.now()` 只允许出现在 `runtime/clock.ts`。
 */

/** 0 = 周日 … 6 = 周六（与 `Intl` 的 weekday 顺序、`Date.getUTCDay()` 一致） */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6

/** 需求 5.1 的短名（小写） */
export const WEEKDAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const

export type WeekdayName = (typeof WEEKDAY_NAMES)[number]

export const ALL_DAYS: readonly Weekday[] = [0, 1, 2, 3, 4, 5, 6]
export const WORKDAYS: readonly Weekday[] = [1, 2, 3, 4, 5]
export const WEEKENDS: readonly Weekday[] = [0, 6]

const SHORTCUTS: Readonly<Record<string, readonly Weekday[]>> = {
  all: ALL_DAYS,
  workdays: WORKDAYS,
  weekends: WEEKENDS,
}

/** `days` 配置非法时抛出。字段路径由调用方（配置校验器）补上。 */
export class DaySelectorError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DaySelectorError'
  }
}

export type DaySelectorInput = 'all' | 'workdays' | 'weekends' | readonly string[]

export type DaySelector = readonly Weekday[]

function resolveShortcut(raw: string): DaySelector | undefined {
  return SHORTCUTS[raw.trim().toLowerCase()]
}

function resolveName(raw: string): Weekday | undefined {
  const index = WEEKDAY_NAMES.indexOf(raw.trim().toLowerCase() as WeekdayName)
  return index < 0 ? undefined : (index as Weekday)
}

/**
 * 把配置值规范成去重、升序的 `Weekday[]`。
 *
 * - `undefined` → 全部 7 天（对应需求 5.1 中 `days` 缺省为 `all`）
 * - 数组里可以混用短名与快捷值（`['workdays', 'sun']`）
 * - **空数组抛错**：`days: []` 是写错了，静默当成 `all` 会掩盖配置错误（需求 8.6）
 *
 * @throws {DaySelectorError} 空数组、未知短名、拼错的快捷值、非数组非字符串
 */
export function parseDaySelector(input?: DaySelectorInput): DaySelector {
  if (input === undefined) return ALL_DAYS

  if (typeof input === 'string') {
    const shortcut = resolveShortcut(input)
    if (shortcut === undefined) {
      throw new DaySelectorError(
        `非法 days 快捷值 ${JSON.stringify(input)}：支持 all / workdays / weekends，或 sun…sat 数组`,
      )
    }
    return shortcut
  }

  if (!Array.isArray(input)) {
    throw new DaySelectorError(`非法 days：应为 all / workdays / weekends 或 sun…sat 数组`)
  }

  const picked = new Set<Weekday>()
  for (const raw of input as readonly unknown[]) {
    if (typeof raw !== 'string') {
      throw new DaySelectorError(`非法 days 元素 ${JSON.stringify(raw)}：应为字符串`)
    }

    const shortcut = resolveShortcut(raw)
    if (shortcut !== undefined) {
      for (const day of shortcut) picked.add(day)
      continue
    }

    const day = resolveName(raw)
    if (day === undefined) {
      throw new DaySelectorError(
        `非法星期 ${JSON.stringify(raw)}：支持 sun / mon / tue / wed / thu / fri / sat，或 all / workdays / weekends`,
      )
    }
    picked.add(day)
  }

  if (picked.size === 0) {
    throw new DaySelectorError('days 不能为空数组（空数组无法匹配任何一天，请显式写 all）')
  }

  return [...picked].sort((a, b) => a - b)
}

/** 判断某个星期是否被选择器命中。 */
export function matchesDay(weekday: Weekday, selector: DaySelector): boolean {
  return selector.includes(weekday)
}

/** 不带时区的「年月日」。 */
export interface PlainDate {
  readonly year: number
  /** 1–12 */
  readonly month: number
  /** 1–31 */
  readonly day: number
}

const MS_PER_DAY = 86_400_000

/** 纯日历推算：把日期前后移动若干天，自动处理跨月、跨年与闰年。 */
export function shiftDate(date: PlainDate, days: number): PlainDate {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day) + days * MS_PER_DAY)
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  }
}

/** 该日期是星期几（0 = 周日）。 */
export function weekdayOf(date: PlainDate): Weekday {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay() as Weekday
}

/** 规范化成 `YYYY-MM-DD`，用于日期比较与按天去重。 */
export function toDateKey(date: PlainDate): string {
  const month = String(date.month).padStart(2, '0')
  const day = String(date.day).padStart(2, '0')
  return `${date.year}-${month}-${day}`
}
