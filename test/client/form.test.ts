import { describe, expect, it } from 'vitest'

import { normalizeHeartbeatConfig } from '../../src/config.js'
import type { TaskForm } from '../../src/client/form.js'
import {
  groupIssuesByTask,
  newTaskForm,
  switchScheduleType,
  toRawTask,
  toTaskForm,
} from '../../src/client/form.js'

const NOW = Date.UTC(2026, 8, 21, 0, 0, 0)
const OPTIONS = { now: NOW, systemTimezone: 'Asia/Shanghai' }

const BASE_FORM: TaskForm = {
  id: 'morning',
  name: '早间问候',
  enabled: true,
  session: 'session-abc',
  timezone: '',
  onBusy: 'queue',
  missed: 'skip',
  noReplyMax: 3,
  noReplyWindow: '',
  payloadText: '现在是{time}',
  schedule: { type: 'daily', at: '08:00' },
}

describe('newTaskForm', () => {
  it('生成不与现有 id 冲突的建议 id', () => {
    expect(newTaskForm([]).id).toBe('task-1')
    expect(newTaskForm(['task-1']).id).toBe('task-2')
    expect(newTaskForm(['task-1', 'task-2']).id).toBe('task-3')
  })

  it('默认值适合「新建后立刻能填」', () => {
    const form = newTaskForm([])
    expect(form).toMatchObject({
      name: '',
      enabled: true,
      session: '',
      timezone: '',
      onBusy: 'queue',
      missed: 'skip',
      noReplyMax: 3,
      noReplyWindow: '',
      payloadText: '',
    })
    expect(form.schedule.type).toBe('daily')
  })
})

describe('toTaskForm — 原始配置 → 表单', () => {
  it('daily', () => {
    const form = toTaskForm({
      id: 'daily',
      session: 's1',
      schedule: { type: 'daily', at: '08:00' },
      payload: { text: '早' },
    })
    expect(form?.schedule).toEqual({ type: 'daily', at: '08:00' })
    expect(form?.payloadText).toBe('早')
  })

  it('once 是日期+时间', () => {
    const form = toTaskForm({
      id: 'once',
      session: 's1',
      schedule: { type: 'once', at: '2026-09-22 08:00' },
      payload: { text: 'x' },
    })
    expect(form?.schedule).toEqual({ type: 'once', at: '2026-09-22 08:00' })
  })

  it('weekly：显式数组 → daysMode=custom', () => {
    const form = toTaskForm({
      id: 'w',
      session: 's1',
      schedule: { type: 'weekly', at: '09:30', days: ['mon', 'fri'] },
      payload: { text: 'x' },
    })
    expect(form?.schedule).toEqual({
      type: 'weekly',
      at: '09:30',
      daysMode: 'custom',
      days: ['mon', 'fri'],
    })
  })

  it('weekly：快捷值 → daysMode=workdays', () => {
    const form = toTaskForm({
      id: 'w',
      session: 's1',
      schedule: { type: 'weekly', at: '09:30', days: 'workdays' },
      payload: { text: 'x' },
    })
    expect(form?.schedule).toMatchObject({ type: 'weekly', daysMode: 'workdays' })
  })

  it('interval', () => {
    const form = toTaskForm({
      id: 'i',
      session: 's1',
      schedule: { type: 'interval', every: '30m', anchor: 'interval-end' },
      payload: { text: 'x' },
    })
    expect(form?.schedule).toEqual({ type: 'interval', every: '30m', anchor: 'interval-end' })
  })

  it('windowed-interval 的窗口拆分到两个字段', () => {
    const form = toTaskForm({
      id: 'wi',
      session: 's1',
      schedule: {
        type: 'windowed-interval',
        days: 'workdays',
        window: { start: '08:00', end: '16:30' },
        every: '30m',
        align: 'window-start',
      },
      payload: { text: 'x' },
    })
    expect(form?.schedule).toEqual({
      type: 'windowed-interval',
      daysMode: 'workdays',
      days: [],
      windowStart: '08:00',
      windowEnd: '16:30',
      every: '30m',
      align: 'window-start',
    })
  })

  it('缺失的可选字段取界面默认值（name 留空让占位符显示 id）', () => {
    const form = toTaskForm({
      id: 'daily',
      session: 's1',
      schedule: { type: 'daily', at: '08:00' },
      payload: { text: 'x' },
    })
    expect(form?.name).toBe('')
    expect(form?.timezone).toBe('')
    expect(form?.enabled).toBe(true)
    expect(form?.noReplyMax).toBe(3)
    expect(form?.noReplyWindow).toBe('')
  })
})

describe('toTaskForm — 坏配置返回 null（不猜）', () => {
  it('非对象 / 缺 schedule / 未知 type 都返回 null', () => {
    expect(toTaskForm(null)).toBeNull()
    expect(toTaskForm('nope')).toBeNull()
    expect(toTaskForm({ id: 'x', session: 's' })).toBeNull()
    expect(toTaskForm({ id: 'x', session: 's', schedule: { type: 'cron' } })).toBeNull()
    expect(toTaskForm({ id: 'x', session: 's', schedule: { type: 'daily' } })).toBeNull()
  })
})

describe('toRawTask — 表单 → 原始配置', () => {
  it('每种类型都产出 normalizeHeartbeatConfig 能接受的形状', () => {
    const forms: readonly TaskForm[] = [
      BASE_FORM,
      { ...BASE_FORM, schedule: { type: 'once', at: '2026-09-22 08:00' } },
      {
        ...BASE_FORM,
        schedule: { type: 'weekly', at: '09:30', daysMode: 'custom', days: ['mon', 'fri'] },
      },
      {
        ...BASE_FORM,
        schedule: { type: 'weekly', at: '09:30', daysMode: 'workdays', days: [] },
      },
      { ...BASE_FORM, schedule: { type: 'interval', every: '30m', anchor: 'enable-time' } },
      {
        ...BASE_FORM,
        schedule: {
          type: 'windowed-interval',
          daysMode: 'all',
          days: [],
          windowStart: '08:00',
          windowEnd: '16:00',
          every: '30m',
          align: 'window-start',
        },
      },
    ]

    for (const form of forms) {
      const result = normalizeHeartbeatConfig({ tasks: [toRawTask(form)] }, OPTIONS)
      expect(result.ok, `类型 ${form.schedule.type} 未能通过配置校验`).toBe(true)
    }
  })

  it('自定义星期写数组，快捷值写字面量', () => {
    const custom = toRawTask({
      ...BASE_FORM,
      schedule: { type: 'weekly', at: '09:30', daysMode: 'custom', days: ['mon'] },
    })
    expect(custom.schedule).toMatchObject({ days: ['mon'] })

    const shortcut = toRawTask({
      ...BASE_FORM,
      schedule: { type: 'weekly', at: '09:30', daysMode: 'weekends', days: [] },
    })
    expect(shortcut.schedule).toMatchObject({ days: 'weekends' })
  })

  it('空字符串的可选字段不写出去（保持配置文件干净）', () => {
    const raw = toRawTask({ ...BASE_FORM, name: '', timezone: '', noReplyWindow: '' })
    expect(raw).not.toHaveProperty('timezone')
    expect(Object.keys(raw as Record<string, unknown>)).not.toContain('name')
    expect(raw.noReply).toEqual({ max: 3 })
  })

  it('payload 一定写成 { kind: prompt, text }', () => {
    const raw = toRawTask(BASE_FORM)
    expect(raw.payload).toEqual({ kind: 'prompt', text: '现在是{time}' })
  })
})

describe('往返一致（表单 → 原始 → 表单）', () => {
  it('六种形态都能原样往返', () => {
    const forms: readonly TaskForm[] = [
      BASE_FORM,
      { ...BASE_FORM, schedule: { type: 'once', at: '2026-09-22 08:00' } },
      {
        ...BASE_FORM,
        schedule: { type: 'weekly', at: '09:30', daysMode: 'custom', days: ['mon', 'fri'] },
      },
      {
        ...BASE_FORM,
        schedule: { type: 'weekly', at: '09:30', daysMode: 'workdays', days: [] },
      },
      { ...BASE_FORM, schedule: { type: 'interval', every: '2h', anchor: 'interval-end' } },
      {
        ...BASE_FORM,
        schedule: {
          type: 'windowed-interval',
          daysMode: 'custom',
          days: ['sat', 'sun'],
          windowStart: '22:00',
          windowEnd: '02:00',
          every: '30m',
          align: 'enable-time',
        },
      },
    ]

    for (const form of forms) {
      expect(toTaskForm(toRawTask(form))).toEqual(form)
    }
  })

  it('非空的 noReply.window 往返保留', () => {
    const form: TaskForm = { ...BASE_FORM, noReplyMax: 5, noReplyWindow: '10m' }
    expect(toTaskForm(toRawTask(form))).toEqual(form)
  })
})

describe('switchScheduleType — 切换类型保留公共字段', () => {
  it('保留 id/name/session/payload/无回应设置，只重置调度部分', () => {
    const switched = switchScheduleType(BASE_FORM, 'interval')

    expect(switched).toMatchObject({
      id: 'morning',
      name: '早间问候',
      session: 'session-abc',
      payloadText: '现在是{time}',
      noReplyMax: 3,
    })
    expect(switched.schedule.type).toBe('interval')
  })

  it('每一种目标类型都给出可用的默认调度字段', () => {
    for (const type of ['once', 'daily', 'weekly', 'interval', 'windowed-interval'] as const) {
      const switched = switchScheduleType(BASE_FORM, type)
      expect(switched.schedule.type).toBe(type)
      // 默认值应当能直接通过配置校验（除了需要用户填的 id/session）
      const result = normalizeHeartbeatConfig(
        { tasks: [{ ...toRawTask(switched), id: 'x', session: 's' }] },
        OPTIONS,
      )
      expect(result.ok, `切到 ${type} 后默认值不合法`).toBe(true)
    }
  })

  it('切到同一类型时原样返回', () => {
    expect(switchScheduleType(BASE_FORM, 'daily')).toEqual(BASE_FORM)
  })
})

describe('groupIssuesByTask — 把配置错误挂到对应任务上', () => {
  it('解析 tasks[i].field 路径', () => {
    const grouped = groupIssuesByTask([
      { path: 'tasks[2].payload.text', message: 'A' },
      { path: 'tasks[0].schedule.at', message: 'B' },
      { path: 'tasks[0].id', message: 'C' },
    ])

    expect(grouped.get(0)?.map((issue) => issue.message)).toEqual(['B', 'C'])
    expect(grouped.get(2)?.map((issue) => issue.message)).toEqual(['A'])
  })

  it('全局错误不挂到任何任务上', () => {
    const grouped = groupIssuesByTask([
      { path: 'enabled', message: '全局' },
      { path: '', message: '根' },
    ])
    expect(grouped.size).toBe(0)
  })

  it('无法解析的路径被忽略，不抛错', () => {
    const grouped = groupIssuesByTask([{ path: 'tasks[abc].x', message: '?' }])
    expect(grouped.size).toBe(0)
  })

  it('空输入 → 空 Map', () => {
    expect(groupIssuesByTask([]).size).toBe(0)
  })
})
