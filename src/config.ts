/**
 * 配置组装层：原始 YAML 形状 → 归一化配置（技术设计 3 章）。
 *
 * 三条硬约束：
 * 1. **不读时钟**：`now` 与 `systemTimezone` 都由调用方注入，保证可测。
 * 2. **错误一次性全部报出**（需求 8.6），每条错误都带 `tasks[i].field` 形式的路径。
 * 3. **能存在的语义问题不阻断加载**：例如「`once` 已过期」不是配置错误，而是
 *    产出 `initialError`，让任务以 `ERROR` 状态存在并可在界面上看到（D-8 ①）。
 */

import type { DaySelector, DaySelectorInput } from './schedule/calendar.js'
import { ALL_DAYS, DaySelectorError, parseDaySelector } from './schedule/calendar.js'
import { DurationError, parseDuration, parseIntervalDuration } from './schedule/duration.js'
import type { IntervalAnchor, NormalizedSchedule, WindowAlign } from './schedule/next-fire.js'
import type { WallTime } from './schedule/zone.js'
import { normalizeZone, ZoneError, zonedInstant } from './schedule/zone.js'
import type { TemplateNode } from './templating/parse.js'
import { parseTemplate } from './templating/parse.js'

export type OnBusy = 'skip' | 'queue' | 'inject'
export type MissedPolicy = 'skip' | 'fire-once'
export type ColdWake = 'session-controller' | 'never'
export type SingleInstance = 'block' | 'warn' | 'off'

const ON_BUSY_VALUES: readonly OnBusy[] = ['skip', 'queue', 'inject']
const MISSED_VALUES: readonly MissedPolicy[] = ['skip', 'fire-once']
const COLD_WAKE_VALUES: readonly ColdWake[] = ['session-controller', 'never']
const SINGLE_INSTANCE_VALUES: readonly SingleInstance[] = ['block', 'warn', 'off']
const INTERVAL_ANCHOR_VALUES: readonly IntervalAnchor[] = ['enable-time', 'interval-end']
const WINDOW_ALIGN_VALUES: readonly WindowAlign[] = ['window-start', 'enable-time']

const TASK_ID_RE = /^[a-z0-9][a-z0-9-]*$/
const TIME_RE = /^(\d{2}):(\d{2})$/
const DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/

const DEFAULT_NO_REPLY_MAX = 3
const MAX_NO_REPLY_MAX = 20

export interface ConfigIssue {
  /** 字段路径，例如 `tasks[0].schedule.every` */
  readonly path: string
  readonly message: string
}

export interface NormalizedNoReply {
  readonly max: number
  /** `null` = 判定策略 A（FR-5 第 3 条） */
  readonly windowMs: number | null
}

export interface NormalizedPayload {
  readonly text: string
  /** 加载期编译好的节点树，触发时直接复用（FR-7 第 2 条只重跑求值） */
  readonly nodes: readonly TemplateNode[]
}

export interface NormalizedTask {
  readonly id: string
  readonly name: string
  readonly enabled: boolean
  readonly session: string
  readonly timezone: string
  readonly schedule: NormalizedSchedule
  readonly onBusy: OnBusy
  readonly missed: MissedPolicy
  readonly payload: NormalizedPayload
  readonly noReply: NormalizedNoReply
  /** 加载期就成立的错误（目前仅 `once-expired`）→ 任务以 ERROR 状态创建 */
  readonly initialError: string | null
}

export interface NormalizedHeartbeatConfig {
  readonly enabled: boolean
  readonly timezone: string
  readonly coldWake: ColdWake
  readonly singleInstance: SingleInstance
  readonly tasks: readonly NormalizedTask[]
}

export type NormalizeConfigResult =
  | {
      readonly ok: true
      readonly config: NormalizedHeartbeatConfig
      /** 不阻断加载、但需要提示给用户的问题 */
      readonly warnings: readonly ConfigIssue[]
    }
  | { readonly ok: false; readonly errors: readonly ConfigIssue[] }

export interface NormalizeOptions {
  /** 判定 `once` 是否已过期的基准时刻（由调用方注入） */
  readonly now: number
  /** `timezone` 缺省时使用的系统时区 */
  readonly systemTimezone: string
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function describe(value: unknown): string {
  return typeof value === 'string' ? JSON.stringify(value) : String(value)
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function readBoolean(
  value: unknown,
  fallback: boolean,
  path: string,
  errors: ConfigIssue[],
): boolean {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') {
    errors.push({ path, message: `应为布尔值（true / false），收到 ${describe(value)}` })
    return fallback
  }
  return value
}

function readString(
  value: unknown,
  fallback: string,
  path: string,
  errors: ConfigIssue[],
): string {
  if (value === undefined) return fallback
  if (typeof value !== 'string') {
    errors.push({ path, message: `应为字符串，收到 ${describe(value)}` })
    return fallback
  }
  return value
}

function readRequiredString(value: unknown, path: string, errors: ConfigIssue[]): string {
  if (typeof value !== 'string' || value.trim() === '') {
    errors.push({ path, message: '必填，且不能为空字符串' })
    return ''
  }
  return value
}

function readEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
  path: string,
  errors: ConfigIssue[],
): T {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    errors.push({
      path,
      message: `应为 ${allowed.join(' | ')} 之一，收到 ${describe(value)}`,
    })
    return fallback
  }
  return value as T
}

function readTimezone(
  value: unknown,
  fallback: string,
  path: string,
  errors: ConfigIssue[],
): string {
  if (value === undefined) return normalizeZone(undefined, fallback)
  if (typeof value !== 'string') {
    errors.push({ path, message: `应为 IANA 时区名，收到 ${describe(value)}` })
    return fallback
  }
  try {
    return normalizeZone(value, fallback)
  } catch (error) {
    errors.push({ path, message: describeError(error) })
    return fallback
  }
}

function readTimeOfDay(value: unknown, path: string, errors: ConfigIssue[]): number | null {
  if (typeof value !== 'string') {
    errors.push({ path, message: `应为 HH:mm，收到 ${describe(value)}` })
    return null
  }

  const matched = TIME_RE.exec(value)
  if (matched === null) {
    errors.push({ path, message: `应为 HH:mm（两位补零的 24 小时制），例如 08:00，收到 ${describe(value)}` })
    return null
  }

  const hour = Number(matched[1] as string)
  const minute = Number(matched[2] as string)
  if (hour > 23 || minute > 59) {
    errors.push({ path, message: `非法时刻 ${describe(value)}（时 00–23、分 00–59）` })
    return null
  }
  return hour * 60 + minute
}

function readEvery(value: unknown, path: string, errors: ConfigIssue[]): number | null {
  if (typeof value !== 'string') {
    errors.push({ path, message: `应为时长字符串（如 30m / 2h），收到 ${describe(value)}` })
    return null
  }
  try {
    return parseIntervalDuration(value)
  } catch (error) {
    errors.push({ path, message: describeError(error) })
    return null
  }
}

function readDays(value: unknown, path: string, errors: ConfigIssue[]): DaySelector {
  try {
    return parseDaySelector(value as DaySelectorInput)
  } catch (error) {
    if (error instanceof DaySelectorError) {
      errors.push({ path, message: error.message })
      return ALL_DAYS
    }
    throw error
  }
}

function readPayload(
  value: unknown,
  path: string,
  errors: ConfigIssue[],
): NormalizedPayload {
  if (!isPlainObject(value)) {
    errors.push({ path, message: '必须填写 payload: { kind: prompt, text: "…" }' })
    return { text: '', nodes: [] }
  }

  const text = typeof value.text === 'string' ? value.text : ''
  if (text.trim() === '') {
    errors.push({
      path: `${path}.text`,
      message: '必须填写投递文案（D-1：文案由用户手写，组件不代写）',
    })
    return { text, nodes: [] }
  }

  const parsed = parseTemplate(text)
  if (!parsed.ok) {
    for (const issue of parsed.errors) {
      errors.push({ path: `${path}.text`, message: issue.message })
    }
    return { text, nodes: [] }
  }

  return { text, nodes: parsed.nodes }
}

function readNoReply(value: unknown, path: string, errors: ConfigIssue[]): NormalizedNoReply {
  if (value === undefined) return { max: DEFAULT_NO_REPLY_MAX, windowMs: null }

  if (!isPlainObject(value)) {
    errors.push({ path, message: `应为 { max, window } 对象，收到 ${describe(value)}` })
    return { max: DEFAULT_NO_REPLY_MAX, windowMs: null }
  }

  let max = DEFAULT_NO_REPLY_MAX
  if (value.max !== undefined) {
    if (
      typeof value.max !== 'number' ||
      !Number.isInteger(value.max) ||
      value.max < 0 ||
      value.max > MAX_NO_REPLY_MAX
    ) {
      errors.push({
        path: `${path}.max`,
        message: `应为 0–${MAX_NO_REPLY_MAX} 的整数（0 表示关闭自动静默），收到 ${describe(value.max)}`,
      })
    } else {
      max = value.max
    }
  }

  let windowMs: number | null = null
  if (value.window !== undefined) {
    if (typeof value.window !== 'string') {
      errors.push({ path: `${path}.window`, message: `应为时长字符串，如 10m，收到 ${describe(value.window)}` })
    } else {
      try {
        // 判定窗口不受「间隔最小 1 分钟」约束（技术设计 3.3）
        windowMs = parseDuration(value.window)
      } catch (error) {
        if (error instanceof DurationError) {
          errors.push({ path: `${path}.window`, message: error.message })
        } else {
          throw error
        }
      }
    }
  }

  return { max, windowMs }
}

interface ScheduleRead {
  readonly schedule: NormalizedSchedule | null
  readonly initialError: string | null
}

function readOnce(
  value: Record<string, unknown>,
  path: string,
  timezone: string,
  options: NormalizeOptions,
  errors: ConfigIssue[],
  warnings: ConfigIssue[],
): ScheduleRead {
  const at = value.at
  if (typeof at !== 'string') {
    errors.push({ path: `${path}.at`, message: `应为 "YYYY-MM-DD HH:mm"，收到 ${describe(at)}` })
    return { schedule: null, initialError: null }
  }

  const matched = DATETIME_RE.exec(at)
  if (matched === null) {
    errors.push({
      path: `${path}.at`,
      message: `应为 "YYYY-MM-DD HH:mm"（例如 "2026-09-18 08:00"），收到 ${describe(at)}`,
    })
    return { schedule: null, initialError: null }
  }

  const wall: WallTime = {
    year: Number(matched[1] as string),
    month: Number(matched[2] as string),
    day: Number(matched[3] as string),
    hour: Number(matched[4] as string),
    minute: Number(matched[5] as string),
    second: 0,
  }

  let instant: number
  try {
    instant = zonedInstant(wall, timezone)
  } catch (error) {
    if (!(error instanceof ZoneError)) throw error
    errors.push({ path: `${path}.at`, message: error.message })
    return { schedule: null, initialError: null }
  }

  // 已过期不是配置语法错误，而是一个「任务无法触发」的事实（D-8 ①）
  if (instant <= options.now) {
    warnings.push({
      path: `${path}.at`,
      message: `once 任务的时刻已过（${at}），不会触发；请修改时间或停用该任务`,
    })
    return { schedule: { kind: 'once', at: instant }, initialError: 'once-expired' }
  }

  return { schedule: { kind: 'once', at: instant }, initialError: null }
}

function readSchedule(
  value: unknown,
  path: string,
  timezone: string,
  options: NormalizeOptions,
  errors: ConfigIssue[],
  warnings: ConfigIssue[],
): ScheduleRead {
  if (!isPlainObject(value)) {
    errors.push({ path, message: '必须填写 schedule 对象' })
    return { schedule: null, initialError: null }
  }

  const type = value.type
  if (typeof type !== 'string' || type === '') {
    errors.push({ path: `${path}.type`, message: '必须填写 schedule.type' })
    return { schedule: null, initialError: null }
  }

  switch (type) {
    case 'once':
      return readOnce(value, path, timezone, options, errors, warnings)

    case 'daily': {
      const timeOfDay = readTimeOfDay(value.at, `${path}.at`, errors)
      if (timeOfDay === null) return { schedule: null, initialError: null }
      return { schedule: { kind: 'daily', timeOfDay }, initialError: null }
    }

    case 'weekly': {
      const timeOfDay = readTimeOfDay(value.at, `${path}.at`, errors)
      const days = readDays(value.days, `${path}.days`, errors)
      if (timeOfDay === null) return { schedule: null, initialError: null }
      return { schedule: { kind: 'weekly', timeOfDay, days }, initialError: null }
    }

    case 'interval': {
      const everyMs = readEvery(value.every, `${path}.every`, errors)
      const anchor = readEnum(
        value.anchor,
        INTERVAL_ANCHOR_VALUES,
        'enable-time',
        `${path}.anchor`,
        errors,
      )
      if (everyMs === null) return { schedule: null, initialError: null }
      return { schedule: { kind: 'interval', everyMs, anchor }, initialError: null }
    }

    case 'windowed-interval': {
      const everyMs = readEvery(value.every, `${path}.every`, errors)
      const days = readDays(value.days, `${path}.days`, errors)
      const align = readEnum(
        value.align,
        WINDOW_ALIGN_VALUES,
        'window-start',
        `${path}.align`,
        errors,
      )

      let startMinute: number | null = null
      let endMinute: number | null = null
      if (!isPlainObject(value.window)) {
        errors.push({ path: `${path}.window`, message: '必须填写 window: { start: "08:00", end: "16:00" }' })
      } else {
        startMinute = readTimeOfDay(value.window.start, `${path}.window.start`, errors)
        endMinute = readTimeOfDay(value.window.end, `${path}.window.end`, errors)
      }

      if (everyMs === null || startMinute === null || endMinute === null) {
        return { schedule: null, initialError: null }
      }
      return {
        schedule: { kind: 'windowed-interval', everyMs, days, startMinute, endMinute, align },
        initialError: null,
      }
    }

    default:
      errors.push({
        path: `${path}.type`,
        message: `未知的 schedule.type ${describe(type)}：支持 once / daily / weekly / interval / windowed-interval`,
      })
      return { schedule: null, initialError: null }
  }
}

function normalizeTask(
  item: unknown,
  index: number,
  globalTimezone: string,
  options: NormalizeOptions,
  errors: ConfigIssue[],
  warnings: ConfigIssue[],
  seenIds: Set<string>,
): NormalizedTask | null {
  const path = `tasks[${index}]`

  if (!isPlainObject(item)) {
    errors.push({ path, message: `应为对象，收到 ${describe(item)}` })
    return null
  }

  const before = errors.length

  let id = ''
  const rawId = item.id
  if (typeof rawId !== 'string' || rawId.trim() === '') {
    errors.push({ path: `${path}.id`, message: '必须填写任务 id' })
  } else if (!TASK_ID_RE.test(rawId)) {
    errors.push({
      path: `${path}.id`,
      message: `id 只能用小写字母、数字与连字符，且以字母或数字开头，收到 ${describe(rawId)}`,
    })
  } else if (seenIds.has(rawId)) {
    errors.push({ path: `${path}.id`, message: `id ${describe(rawId)} 与前面的任务重复` })
  } else {
    id = rawId
    seenIds.add(rawId)
  }

  const name = readString(item.name, id, `${path}.name`, errors)
  const enabled = readBoolean(item.enabled, true, `${path}.enabled`, errors)
  const session = readRequiredString(item.session, `${path}.session`, errors)
  const timezone = readTimezone(item.timezone, globalTimezone, `${path}.timezone`, errors)
  const onBusy = readEnum(item.onBusy, ON_BUSY_VALUES, 'queue', `${path}.onBusy`, errors)
  const missed = readEnum(item.missed, MISSED_VALUES, 'skip', `${path}.missed`, errors)
  const noReply = readNoReply(item.noReply, `${path}.noReply`, errors)
  const payload = readPayload(item.payload, `${path}.payload`, errors)
  const { schedule, initialError } = readSchedule(
    item.schedule,
    `${path}.schedule`,
    timezone,
    options,
    errors,
    warnings,
  )

  if (errors.length > before || schedule === null) return null

  return {
    id,
    name,
    enabled,
    session,
    timezone,
    schedule,
    onBusy,
    missed,
    payload,
    noReply,
    initialError,
  }
}

/**
 * 归一化整份心跳配置。
 *
 * @returns 全部字段合法时 `ok: true`（附 `warnings`）；否则 `ok: false` 并给出
 *   **全部**错误（需求 8.6：不能遇到第一个就停）。
 */
export function normalizeHeartbeatConfig(
  raw: unknown,
  options: NormalizeOptions,
): NormalizeConfigResult {
  if (!isPlainObject(raw)) {
    return { ok: false, errors: [{ path: '', message: '配置根节点必须是对象' }] }
  }

  const errors: ConfigIssue[] = []
  const warnings: ConfigIssue[] = []

  const enabled = readBoolean(raw.enabled, true, 'enabled', errors)
  const timezone = readTimezone(raw.timezone, options.systemTimezone, 'timezone', errors)
  const coldWake = readEnum(raw.coldWake, COLD_WAKE_VALUES, 'session-controller', 'coldWake', errors)
  const singleInstance = readEnum(
    raw.singleInstance,
    SINGLE_INSTANCE_VALUES,
    'warn',
    'singleInstance',
    errors,
  )

  const tasks: NormalizedTask[] = []
  if (raw.tasks === undefined) {
    // 允许完全没有任务：组件加载后处于「无任务」的空转状态
  } else if (!Array.isArray(raw.tasks)) {
    errors.push({ path: 'tasks', message: `应为数组，收到 ${describe(raw.tasks)}` })
  } else {
    const seenIds = new Set<string>()
    raw.tasks.forEach((item, index) => {
      const task = normalizeTask(item, index, timezone, options, errors, warnings, seenIds)
      if (task !== null) tasks.push(task)
    })
  }

  if (errors.length > 0) return { ok: false, errors }

  return {
    ok: true,
    config: { enabled, timezone, coldWake, singleInstance, tasks },
    warnings,
  }
}
