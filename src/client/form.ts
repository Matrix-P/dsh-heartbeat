/**
 * 任务表单模型（技术设计 10.4）：**表单 ↔ 原始配置**的双向转换，纯函数。
 *
 * 为什么要单独一层：
 * - 表单需要「按调度类型切换字段」，原始配置是 5 种判别联合；直接双向绑定会到处写分支；
 * - 界面上有「快捷值」（全部 / 工作日 / 周末）这种并非 YAML 原生的呈现；
 * - 需要一个**可往返**的中间表示，否则用户点一下「编辑」再保存就会丢字段。
 *
 * 本模块**不读时钟**：`once` 的默认时刻由调用方通过 `options.now` 传入。
 */

import type { ConfigIssue } from '../config.js'
import type { MissedPolicy, OnBusy } from '../config.js'
import { formatZoned } from '../schedule/zone.js'

export type ScheduleType = 'once' | 'daily' | 'weekly' | 'interval' | 'windowed-interval'
export type DaysMode = 'all' | 'workdays' | 'weekends' | 'custom'
export type IntervalAnchorForm = 'enable-time' | 'interval-end'
export type WindowAlignForm = 'window-start' | 'enable-time'

export type ScheduleForm =
  | { readonly type: 'once'; readonly at: string }
  | { readonly type: 'daily'; readonly at: string }
  | {
      readonly type: 'weekly'
      readonly at: string
      readonly daysMode: DaysMode
      readonly days: readonly string[]
    }
  | { readonly type: 'interval'; readonly every: string; readonly anchor: IntervalAnchorForm }
  | {
      readonly type: 'windowed-interval'
      readonly daysMode: DaysMode
      readonly days: readonly string[]
      readonly windowStart: string
      readonly windowEnd: string
      readonly every: string
      readonly align: WindowAlignForm
    }

export interface TaskForm {
  readonly id: string
  readonly name: string
  readonly enabled: boolean
  readonly session: string
  readonly timezone: string
  readonly onBusy: OnBusy
  readonly missed: MissedPolicy
  readonly noReplyMax: number
  readonly noReplyWindow: string
  readonly payloadText: string
  readonly schedule: ScheduleForm
}

export interface SwitchOptions {
  /** 生成 `once` 默认时刻用的「现在」（由调用方注入，本模块不读时钟） */
  readonly now?: number
  readonly timezone?: string
}

const TIME_RE = /^\d{2}:\d{2}$/
const DATE_TIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/
const TASK_PATH_RE = /^tasks\[(\d+)\]/

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asTime(value: unknown): string | null {
  return typeof value === 'string' && TIME_RE.test(value) ? value : null
}

function asDateTime(value: unknown): string | null {
  return typeof value === 'string' && DATE_TIME_RE.test(value) ? value : null
}

function asDuration(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function readDays(value: unknown): { daysMode: DaysMode; days: readonly string[] } {
  if (value === 'all' || value === 'workdays' || value === 'weekends') {
    return { daysMode: value, days: [] }
  }
  if (Array.isArray(value)) {
    return {
      daysMode: 'custom',
      days: value.filter((item): item is string => typeof item === 'string'),
    }
  }
  return { daysMode: 'all', days: [] }
}

function daysToRaw(schedule: { daysMode: DaysMode; days: readonly string[] }): unknown {
  return schedule.daysMode === 'custom' ? [...schedule.days] : schedule.daysMode
}

/** 每种调度类型的表单默认值。 */
export function defaultSchedule(type: ScheduleType, options: SwitchOptions = {}): ScheduleForm {
  switch (type) {
    case 'once': {
      const at = formatZoned(
        (options.now ?? 0) + 3_600_000,
        options.timezone ?? 'UTC',
        'YYYY-MM-DD HH:mm',
      )
      return { type: 'once', at }
    }
    case 'daily':
      return { type: 'daily', at: '09:00' }
    case 'weekly':
      return { type: 'weekly', at: '09:00', daysMode: 'workdays', days: [] }
    case 'interval':
      return { type: 'interval', every: '30m', anchor: 'enable-time' }
    case 'windowed-interval':
      return {
        type: 'windowed-interval',
        daysMode: 'workdays',
        days: [],
        windowStart: '08:00',
        windowEnd: '16:00',
        every: '30m',
        align: 'window-start',
      }
  }
}

/** 新建任务的表单骨架；`id` 会避开已有 id。 */
export function newTaskForm(existingIds: readonly string[] = []): TaskForm {
  const taken = new Set(existingIds)
  let index = 1
  while (taken.has(`task-${index}`)) index += 1

  return {
    id: `task-${index}`,
    name: '',
    enabled: true,
    session: '',
    timezone: '',
    onBusy: 'queue',
    missed: 'skip',
    noReplyMax: 3,
    noReplyWindow: '',
    payloadText: '',
    schedule: defaultSchedule('daily'),
  }
}

function readSchedule(value: unknown): ScheduleForm | null {
  if (!isPlainObject(value)) return null

  switch (value.type) {
    case 'once': {
      const at = asDateTime(value.at)
      return at === null ? null : { type: 'once', at }
    }

    case 'daily': {
      const at = asTime(value.at)
      return at === null ? null : { type: 'daily', at }
    }

    case 'weekly': {
      const at = asTime(value.at)
      if (at === null) return null
      return { type: 'weekly', at, ...readDays(value.days) }
    }

    case 'interval': {
      const every = asDuration(value.every)
      if (every === null) return null
      return {
        type: 'interval',
        every,
        anchor: value.anchor === 'interval-end' ? 'interval-end' : 'enable-time',
      }
    }

    case 'windowed-interval': {
      const every = asDuration(value.every)
      if (every === null || !isPlainObject(value.window)) return null
      const windowStart = asTime(value.window.start)
      const windowEnd = asTime(value.window.end)
      if (windowStart === null || windowEnd === null) return null
      return {
        type: 'windowed-interval',
        ...readDays(value.days),
        windowStart,
        windowEnd,
        every,
        align: value.align === 'enable-time' ? 'enable-time' : 'window-start',
      }
    }

    default:
      return null
  }
}

/**
 * 原始配置 → 表单。
 *
 * **解析不出来就返回 `null`**（由界面提示"该任务配置无法解析"），绝不猜一个形状出来 ——
 * 猜出来的表单一旦被保存就会悄悄改坏用户的配置。
 */
export function toTaskForm(raw: unknown): TaskForm | null {
  if (!isPlainObject(raw)) return null

  const schedule = readSchedule(raw.schedule)
  if (schedule === null) return null

  const noReply = isPlainObject(raw.noReply) ? raw.noReply : {}
  const payload = isPlainObject(raw.payload) ? raw.payload : {}

  return {
    id: asString(raw.id),
    name: asString(raw.name),
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : true,
    session: asString(raw.session),
    timezone: asString(raw.timezone),
    onBusy: raw.onBusy === 'skip' || raw.onBusy === 'inject' ? raw.onBusy : 'queue',
    missed: raw.missed === 'fire-once' ? 'fire-once' : 'skip',
    noReplyMax: typeof noReply.max === 'number' ? noReply.max : 3,
    noReplyWindow: asString(noReply.window),
    payloadText: asString(payload.text),
    schedule,
  }
}

function toRawSchedule(schedule: ScheduleForm): Record<string, unknown> {
  switch (schedule.type) {
    case 'once':
      return { type: 'once', at: schedule.at }
    case 'daily':
      return { type: 'daily', at: schedule.at }
    case 'weekly':
      return { type: 'weekly', at: schedule.at, days: daysToRaw(schedule) }
    case 'interval':
      return { type: 'interval', every: schedule.every, anchor: schedule.anchor }
    case 'windowed-interval':
      return {
        type: 'windowed-interval',
        days: daysToRaw(schedule),
        window: { start: schedule.windowStart, end: schedule.windowEnd },
        every: schedule.every,
        align: schedule.align,
      }
  }
}

/** 表单 → 原始配置。等于默认值的可选字段**不写出去**，保持配置文件干净。 */
export function toRawTask(form: TaskForm): Record<string, unknown> {
  const noReply: Record<string, unknown> = { max: form.noReplyMax }
  const window = form.noReplyWindow.trim()
  if (window !== '') noReply.window = window

  const name = form.name.trim()
  const timezone = form.timezone.trim()

  return {
    id: form.id,
    ...(name === '' ? {} : { name }),
    ...(form.enabled ? {} : { enabled: false }),
    session: form.session,
    ...(timezone === '' ? {} : { timezone }),
    schedule: toRawSchedule(form.schedule),
    ...(form.onBusy === 'queue' ? {} : { onBusy: form.onBusy }),
    ...(form.missed === 'skip' ? {} : { missed: form.missed }),
    payload: { kind: 'prompt', text: form.payloadText },
    noReply,
  }
}

/** 切换调度类型：**保留全部公共字段**，只重置该类型专属的调度字段。 */
export function switchScheduleType(
  form: TaskForm,
  type: ScheduleType,
  options: SwitchOptions = {},
): TaskForm {
  if (form.schedule.type === type) return form
  return { ...form, schedule: defaultSchedule(type, options) }
}

/**
 * 把配置错误按任务下标分组，界面据此在出错的任务行上打标记。
 *
 * 路径形如 `tasks[2].payload.text`；全局错误（`enabled` 等）不归任何任务。
 */
export function groupIssuesByTask(
  issues: readonly ConfigIssue[],
): ReadonlyMap<number, readonly ConfigIssue[]> {
  const grouped = new Map<number, ConfigIssue[]>()

  for (const issue of issues) {
    const matched = TASK_PATH_RE.exec(issue.path)
    if (matched === null) continue

    const index = Number(matched[1])
    const list = grouped.get(index)
    if (list === undefined) {
      grouped.set(index, [issue])
    } else {
      list.push(issue)
    }
  }

  return grouped
}
