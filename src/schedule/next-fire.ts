/**
 * 下一次触发时刻推导（技术设计 6.2 / 6.3 节）——**整个组件的心脏**。
 *
 * 核心公式（FR-8）：
 *
 *     base = lastIdleAt ?? anchorAt（或 align 基准）
 *     nextFireAt = base + k × every（k 为使候选满足窗口/日期约束的最小正整数）
 *
 * 设计约束：
 * - **纯函数**：`now` 由调用方传入，绝不读时钟；因此每条规则都能被确定性断言。
 * - **不持久化 nextFireAt**：每次都由本函数重算，因此重启、时钟跳变、热加载
 *   走的是同一条代码路径。
 * - 输入是**已归一化**的规则（字符串已解析为数值、时刻已解析为绝对毫秒）。
 */

import type { DaySelector, PlainDate } from './calendar.js'
import { matchesDay, shiftDate, weekdayOf } from './calendar.js'
import type { WallTime } from './zone.js'
import { ZoneError, zonedInstant, zonedParts } from './zone.js'

const MINUTE_MS = 60_000
const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

/** 规则内部矛盾（例如间隔类两个基准都缺失）时抛出。 */
export class ScheduleError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ScheduleError'
  }
}

export type IntervalAnchor = 'enable-time' | 'interval-end'
export type WindowAlign = 'window-start' | 'enable-time'

/** 已归一化的调度规则：所有字符串都已解析，`once.at` 已是绝对时刻。 */
export type NormalizedSchedule =
  | { readonly kind: 'once'; readonly at: number }
  /** `timeOfDay` = 当天第几分钟（0–1439） */
  | { readonly kind: 'daily'; readonly timeOfDay: number }
  | { readonly kind: 'weekly'; readonly timeOfDay: number; readonly days: DaySelector }
  | { readonly kind: 'interval'; readonly everyMs: number; readonly anchor: IntervalAnchor }
  | {
      readonly kind: 'windowed-interval'
      readonly everyMs: number
      readonly days: DaySelector
      /** 窗口起点 = 当天第几分钟 */
      readonly startMinute: number
      /** 窗口终点 = 当天第几分钟；小于起点表示跨零点 */
      readonly endMinute: number
      readonly align: WindowAlign
    }

export interface NextFireInput {
  readonly schedule: NormalizedSchedule
  readonly timezone: string
  readonly now: number
  /** 任务被启用的时刻 */
  readonly anchorAt: number | null
  readonly lastFiredAt: number | null
  /** 目标会话主 Agent 最近一次「说完」的时刻（FR-8） */
  readonly lastIdleAt: number | null
  /** 目标 Agent 当前是否正在输出（FR-8 输出抑制） */
  readonly agentBusy: boolean
}

/** 窗口搜索前瞻天数（`days` 最短周期为 7 天，14 天足够并留冗余）。 */
export const WINDOW_LOOKAHEAD_DAYS = 14

/**
 * 窗口回看天数。跨零点窗口可能**从前一天开始**并延伸进今天，
 * 因此必须回看 1 天，否则会漏掉「昨天 22:00–今天 02:00」这类窗口的剩余时点。
 */
export const WINDOW_LOOKBACK_DAYS = 1

/** 单个窗口内最多枚举的候选数（防御极长窗口 + 极小 every 造成的组合爆炸）。 */
const MAX_CANDIDATES_PER_WINDOW = 10_000

/** DST 间隙最多向后扫描的分钟数。 */
const DST_GAP_SCAN_MINUTES = 180

/** 把墙上时间按分钟平移（纯 UTC 运算，不读时钟）。 */
function shiftWallMinutes(wall: WallTime, minutes: number): WallTime {
  const shifted = new Date(
    Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute + minutes, wall.second),
  )
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
  }
}

/**
 * 解析墙上时刻为绝对时刻。
 *
 * DST 间隙策略：若该墙上时刻不存在（夏令时前拨），**向后顺延**到间隙之后的
 * 第一个有效时刻（例如纽约 02:30 → 03:00）。这样每周/每天的固定时刻不会
 * 因为一年两次的跳变而整天丢掉。
 */
function resolveWall(wall: WallTime, timezone: string): number {
  let candidate = wall
  for (let scanned = 0; scanned <= DST_GAP_SCAN_MINUTES; scanned += 1) {
    try {
      return zonedInstant(candidate, timezone)
    } catch (error) {
      if (!(error instanceof ZoneError)) throw error
      candidate = shiftWallMinutes(candidate, 1)
    }
  }
  throw new ScheduleError(
    `${timezone} 中无法解析墙上时刻（夏令时间隙超过 ${DST_GAP_SCAN_MINUTES} 分钟）`,
  )
}

function timeOfDayParts(timeOfDay: number): Pick<WallTime, 'hour' | 'minute' | 'second'> {
  return { hour: Math.floor(timeOfDay / 60), minute: timeOfDay % 60, second: 0 }
}

function dayOf(instant: number, timezone: string): PlainDate {
  const parts = zonedParts(instant, timezone)
  return { year: parts.year, month: parts.month, day: parts.day }
}

function wallOfDay(
  day: PlainDate,
  timeOfDay: number,
): WallTime {
  return { year: day.year, month: day.month, day: day.day, ...timeOfDayParts(timeOfDay) }
}

/** 从 `base` 起算、严格大于 `now` 的第一个 `base + k × every`。 */
function nextIntervalAfter(base: number, everyMs: number, now: number): number {
  const elapsed = now - base
  const k = elapsed < 0 ? 1 : Math.floor(elapsed / everyMs) + 1
  return base + k * everyMs
}

function nextDailyAfter(now: number, timeOfDay: number, timezone: string): number {
  const today = dayOf(now, timezone)
  for (let offset = 0; offset <= 2; offset += 1) {
    const candidate = resolveWall(wallOfDay(shiftDate(today, offset), timeOfDay), timezone)
    if (candidate > now) return candidate
  }
  throw new ScheduleError('无法推导 daily 的下一次触发时刻')
}

function nextWeeklyAfter(
  now: number,
  timeOfDay: number,
  days: DaySelector,
  timezone: string,
): number {
  const today = dayOf(now, timezone)
  for (let offset = 0; offset <= 7; offset += 1) {
    const day = shiftDate(today, offset)
    if (!matchesDay(weekdayOf(day), days)) continue
    const candidate = resolveWall(wallOfDay(day, timeOfDay), timezone)
    if (candidate > now) return candidate
  }
  throw new ScheduleError('无法推导 weekly 的下一次触发时刻（days 为空？）')
}

/** 某个窗口的两端（绝对时刻），跨零点时终点落在次日。 */
function windowBounds(
  day: PlainDate,
  startMinute: number,
  endMinute: number,
  timezone: string,
): { start: number; end: number } {
  const start = resolveWall(wallOfDay(day, startMinute), timezone)
  let end = resolveWall(wallOfDay(day, endMinute), timezone)
  // 终点早于（或等于）起点 → 跨零点，归属日仍是起点所在日（需求第 7 章）
  if (end <= start) end += DAY_MS
  return { start, end }
}

/** 枚举某个窗口内的全部候选时点（升序）。 */
function windowCandidates(
  schedule: Extract<NormalizedSchedule, { kind: 'windowed-interval' }>,
  input: NextFireInput,
  day: PlainDate,
): readonly number[] {
  const { start, end } = windowBounds(day, schedule.startMinute, schedule.endMinute, input.timezone)

  // every 大于窗口长度 → 每个窗口只在起点触发一次（FR-3 第 7 条）
  if (schedule.everyMs > end - start) return [start]

  // 基准优先级：模型说完的时刻 > align 基准（FR-8 第 6 条）
  const anchorFallback =
    schedule.align === 'window-start' ? start : input.anchorAt
  const origin = input.lastIdleAt ?? anchorFallback
  if (origin === null) {
    throw new ScheduleError('windowed-interval 缺少计时基准（anchorAt / lastIdleAt 均为空）')
  }

  const firstK = Math.max(0, Math.ceil((start - origin) / schedule.everyMs))
  const candidates: number[] = []
  for (
    let at = origin + firstK * schedule.everyMs;
    at <= end && candidates.length < MAX_CANDIDATES_PER_WINDOW;
    at += schedule.everyMs
  ) {
    candidates.push(at)
  }
  return candidates
}

function nextWindowedAfter(input: NextFireInput): number | null {
  const schedule = input.schedule as Extract<NormalizedSchedule, { kind: 'windowed-interval' }>
  const today = dayOf(input.now, input.timezone)

  let best: number | null = null
  for (
    let offset = -WINDOW_LOOKBACK_DAYS;
    offset <= WINDOW_LOOKAHEAD_DAYS;
    offset += 1
  ) {
    const day = shiftDate(today, offset)
    if (!matchesDay(weekdayOf(day), schedule.days)) continue

    for (const candidate of windowCandidates(schedule, input, day)) {
      if (candidate <= input.now) continue
      if (best === null || candidate < best) best = candidate
    }
  }
  return best
}

/**
 * `interval-end` 的基准 = 「上次触发」与「anchorAt」中**较晚**的一个。
 *
 * 为什么不是简单的 `lastFiredAt ?? anchorAt`：FR-5 第 5 条要求「用户回复后以
 * 当前时刻为基准重算」，实现方式是把 `anchorAt` 重置为回复时刻。若仍优先取
 * `lastFiredAt`，计时会被拉回旧网格，可能在恢复后立刻又触发一次（违背「不补发」）。
 */
function latestOf(a: number | null, b: number | null): number | null {
  if (a === null) return b
  if (b === null) return a
  return Math.max(a, b)
}

function intervalBase(input: NextFireInput): number {
  if (input.lastIdleAt !== null) return input.lastIdleAt

  const schedule = input.schedule as Extract<NormalizedSchedule, { kind: 'interval' }>
  const fallback =
    schedule.anchor === 'interval-end'
      ? latestOf(input.lastFiredAt, input.anchorAt)
      : input.anchorAt

  if (fallback === null) {
    throw new ScheduleError(
      'interval 缺少计时基准：anchorAt 为空（启用中的任务应有 anchorAt），且 lastIdleAt / lastFiredAt 均缺失',
    )
  }
  return fallback
}

/**
 * 推导下一次触发时刻。
 *
 * @returns 严格大于 `now` 的下一次触发时刻；`null` 表示「不会再有下一次」
 *   （`once` 已过期，或 FR-8 输出抑制生效）。
 * @throws {ScheduleError} 规则内部矛盾（缺基准）
 */
export function nextFireAfter(input: NextFireInput): number | null {
  switch (input.schedule.kind) {
    case 'once':
      return input.schedule.at > input.now ? input.schedule.at : null

    case 'daily':
      return nextDailyAfter(input.now, input.schedule.timeOfDay, input.timezone)

    case 'weekly':
      return nextWeeklyAfter(
        input.now,
        input.schedule.timeOfDay,
        input.schedule.days,
        input.timezone,
      )

    case 'interval':
      // FR-8 输出抑制：模型正在说话就不触发（不投递、不计无回应次数）
      if (input.agentBusy) return null
      return nextIntervalAfter(intervalBase(input), input.schedule.everyMs, input.now)

    case 'windowed-interval':
      if (input.agentBusy) return null
      return nextWindowedAfter(input)
  }
}

/** 供日志与调试使用：把绝对时刻渲染成该时区的 `YYYY-MM-DD HH:mm`。 */
export function describeInstant(instant: number | null, timezone: string): string {
  if (instant === null) return '—'
  const parts = zonedParts(instant, timezone)
  const pad = (value: number, width = 2) => String(value).padStart(width, '0')
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)} ${pad(parts.hour)}:${pad(parts.minute)}`
}

/** 固定时刻类任务的迟到宽限；也是间隔类的宽限上限。 */
export const DEFAULT_LATE_GRACE_MS = 60_000

/**
 * 判定「这次唤醒是准点还是错过」的宽限（技术设计 6.4 / 需求第 7 章）。
 *
 * - **间隔类**：`min(60s, max(5s, every / 2))` —— 间隔越短，宽限越紧
 * - **固定时刻类**（`once` / `daily` / `weekly`）：`60s`
 *
 * 为什么不沿用「`every / 2` 不设上限」：`daily` 的 `every` 相当于 24 小时，
 * 那样 12 小时以内的迟到都会被当成准点，等于没有错过判定。
 *
 * 为什么至少 5 秒：需求 8.1 允许固定时刻类有 ≤5 秒的触发误差，宽限必须覆盖它，
 * 否则每次正常触发都会被误判成错过。
 */
export function lateGraceMs(schedule: NormalizedSchedule): number {
  switch (schedule.kind) {
    case 'interval':
    case 'windowed-interval':
      return Math.min(DEFAULT_LATE_GRACE_MS, Math.max(5_000, Math.floor(schedule.everyMs / 2)))
    case 'once':
    case 'daily':
    case 'weekly':
      return DEFAULT_LATE_GRACE_MS
  }
}

export { HOUR_MS, MINUTE_MS, DAY_MS }
