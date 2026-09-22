import { describe, expect, it } from 'vitest'

import type { ConfigIssue, NormalizedHeartbeatConfig } from '../src/config.js'
import { normalizeHeartbeatConfig } from '../src/config.js'

const SYS_TZ = 'Asia/Shanghai'
/** 上海 2026-09-21 08:00（周一） */
const NOW = Date.UTC(2026, 8, 21, 0, 0, 0)
const OPTIONS = { now: NOW, systemTimezone: SYS_TZ }

function config(raw: unknown): NormalizedHeartbeatConfig {
  const result = normalizeHeartbeatConfig(raw, OPTIONS)
  if (!result.ok) {
    throw new Error(`期望配置合法，却报错：${result.errors.map((e) => `${e.path}: ${e.message}`).join(' / ')}`)
  }
  return result.config
}

function issues(raw: unknown): readonly ConfigIssue[] {
  const result = normalizeHeartbeatConfig(raw, OPTIONS)
  if (result.ok) throw new Error('期望配置非法，却通过了校验')
  return result.errors
}

function paths(raw: unknown): string[] {
  return issues(raw).map((issue) => issue.path)
}

const validTask = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'morning',
  session: 'session-abc',
  schedule: { type: 'daily', at: '08:00' },
  payload: { text: '现在是{time}' },
  ...overrides,
})

describe('normalizeHeartbeatConfig — 默认值', () => {
  it('空配置也能出来一份可用的骨架', () => {
    const cfg = config({})
    expect(cfg.enabled).toBe(true)
    expect(cfg.timezone).toBe(SYS_TZ)
    expect(cfg.coldWake).toBe('session-controller')
    expect(cfg.singleInstance).toBe('warn')
    expect(cfg.tasks).toEqual([])
  })

  it('任务级默认值：name 回落 id、enabled 真、继承全局时区、onBusy=queue、missed=skip', () => {
    const cfg = config({ tasks: [validTask()] })
    const task = cfg.tasks[0]
    expect(task?.name).toBe('morning')
    expect(task?.enabled).toBe(true)
    expect(task?.timezone).toBe(SYS_TZ)
    expect(task?.onBusy).toBe('queue')
    expect(task?.missed).toBe('skip')
    expect(task?.noReply).toEqual({ max: 3, windowMs: null })
  })

  it('任务级时区可覆盖全局', () => {
    const cfg = config({
      timezone: 'UTC',
      tasks: [validTask({ timezone: 'America/New_York' })],
    })
    expect(cfg.tasks[0]?.timezone).toBe('America/New_York')
  })

  it('noReply.window 采用策略 B（不受间隔 1 分钟下限约束）', () => {
    const cfg = config({ tasks: [validTask({ noReply: { max: 5, window: '30s' } })] })
    expect(cfg.tasks[0]?.noReply).toEqual({ max: 5, windowMs: 30_000 })
  })
})

describe('normalizeHeartbeatConfig — 五种调度都能归一化', () => {
  it('daily → timeOfDay', () => {
    const cfg = config({ tasks: [validTask({ schedule: { type: 'daily', at: '09:30' } })] })
    expect(cfg.tasks[0]?.schedule).toEqual({ kind: 'daily', timeOfDay: 570 })
  })

  it('weekly → timeOfDay + days', () => {
    const cfg = config({
      tasks: [validTask({ schedule: { type: 'weekly', at: '09:30', days: ['mon', 'fri'] } })],
    })
    expect(cfg.tasks[0]?.schedule).toEqual({ kind: 'weekly', timeOfDay: 570, days: [1, 5] })
  })

  it('once → 按任务时区解析成绝对时刻', () => {
    const cfg = config({
      tasks: [validTask({ schedule: { type: 'once', at: '2026-09-22 08:00' } })],
    })
    expect(cfg.tasks[0]?.schedule).toEqual({ kind: 'once', at: Date.UTC(2026, 8, 22, 0, 0, 0) })
  })

  it('interval → everyMs + anchor', () => {
    const cfg = config({
      tasks: [validTask({ schedule: { type: 'interval', every: '30m', anchor: 'interval-end' } })],
    })
    expect(cfg.tasks[0]?.schedule).toEqual({
      kind: 'interval',
      everyMs: 1_800_000,
      anchor: 'interval-end',
    })
  })

  it('windowed-interval → 窗口起止转成“当天第几分钟”', () => {
    const cfg = config({
      tasks: [
        validTask({
          schedule: {
            type: 'windowed-interval',
            days: 'workdays',
            window: { start: '08:00', end: '16:30' },
            every: '30m',
            align: 'window-start',
          },
        }),
      ],
    })
    expect(cfg.tasks[0]?.schedule).toEqual({
      kind: 'windowed-interval',
      everyMs: 1_800_000,
      days: [1, 2, 3, 4, 5],
      startMinute: 480,
      endMinute: 990,
      align: 'window-start',
    })
  })
})

describe('normalizeHeartbeatConfig — 错误路径带字段名（需求 8.6）', () => {
  it('一次报出多个错误，而不是遇到第一个就停', () => {
    const list = issues({
      enabled: 'yes',
      tasks: [
        validTask({ id: 'Bad_ID' }),
        validTask({ id: 'ok', session: '' }),
        { id: 'no-schedule', session: 'session-x' },
      ],
    })
    // 全局 enabled + 第 1 个任务 id + 第 2 个任务 session + 第 3 个任务缺 schedule/payload
    expect(list.length).toBeGreaterThanOrEqual(4)
  })

  it('路径格式为 tasks[i].field', () => {
    const list = paths({ tasks: [validTask(), validTask({ id: 'ok', session: '' })] })
    expect(list).toContain('tasks[1].session')
  })

  it('全局 enabled 必须是布尔', () => {
    expect(paths({ enabled: 'yes' })).toContain('enabled')
  })

  it('全局 timezone 非法时用回退值而不是静默通过', () => {
    expect(paths({ timezone: 'Not/AZone' })).toContain('timezone')
  })

  it('coldWake / singleInstance 只接受枚举值', () => {
    expect(paths({ coldWake: 'always' })).toContain('coldWake')
    expect(paths({ singleInstance: 'explode' })).toContain('singleInstance')
  })

  it('tasks 必须是数组', () => {
    expect(paths({ tasks: {} })).toContain('tasks')
  })

  it('任务必须是对象', () => {
    expect(paths({ tasks: ['nope'] })).toContain('tasks[0]')
  })
})

describe('normalizeHeartbeatConfig — 任务字段校验', () => {
  it('缺 id / id 格式错 / id 重复', () => {
    expect(paths({ tasks: [{ session: 's', schedule: { type: 'daily', at: '08:00' }, payload: { text: 'x' } }] })).toContain(
      'tasks[0].id',
    )
    expect(paths({ tasks: [validTask({ id: 'Bad_ID' })] })).toContain('tasks[0].id')
    expect(
      paths({ tasks: [validTask(), validTask({ session: 'session-2' })] }),
    ).toContain('tasks[1].id')
  })

  it('缺 session 是必填错误', () => {
    expect(paths({ tasks: [validTask({ session: undefined })] })).toContain('tasks[0].session')
  })

  it('缺 payload.text 是必填错误（D-1）', () => {
    expect(paths({ tasks: [validTask({ payload: {} })] })).toContain('tasks[0].payload.text')
    expect(paths({ tasks: [validTask({ payload: { text: '  ' } })] })).toContain('tasks[0].payload.text')
    expect(paths({ tasks: [validTask({ payload: undefined })] })).toContain('tasks[0].payload')
  })

  it('onBusy / missed 枚举校验', () => {
    expect(paths({ tasks: [validTask({ onBusy: 'later' })] })).toContain('tasks[0].onBusy')
    expect(paths({ tasks: [validTask({ missed: 'fire-all' })] })).toContain('tasks[0].missed')
  })

  it('noReply.max 范围 0–20', () => {
    expect(paths({ tasks: [validTask({ noReply: { max: 21 } })] })).toContain('tasks[0].noReply.max')
    expect(paths({ tasks: [validTask({ noReply: { max: -1 } })] })).toContain('tasks[0].noReply.max')
    expect(config({ tasks: [validTask({ noReply: { max: 0 } })] }).tasks[0]?.noReply.max).toBe(0)
  })

  it('noReply.window 时长格式校验', () => {
    expect(paths({ tasks: [validTask({ noReply: { window: 'abc' } })] })).toContain(
      'tasks[0].noReply.window',
    )
  })
})

describe('normalizeHeartbeatConfig — schedule 校验', () => {
  it('缺 type / 未知 type', () => {
    expect(paths({ tasks: [validTask({ schedule: {} })] })).toContain('tasks[0].schedule.type')
    expect(paths({ tasks: [validTask({ schedule: { type: 'cron' } })] })).toContain(
      'tasks[0].schedule.type',
    )
  })

  it('daily 的 at 必须是 HH:mm', () => {
    expect(paths({ tasks: [validTask({ schedule: { type: 'daily', at: '8:00' } })] })).toContain(
      'tasks[0].schedule.at',
    )
    expect(paths({ tasks: [validTask({ schedule: { type: 'daily', at: '25:00' } })] })).toContain(
      'tasks[0].schedule.at',
    )
  })

  it('weekly 的 days 不能为空数组', () => {
    expect(
      paths({ tasks: [validTask({ schedule: { type: 'weekly', at: '09:00', days: [] } })] }),
    ).toContain('tasks[0].schedule.days')
  })

  it('once 的 at 必须是 YYYY-MM-DD HH:mm', () => {
    expect(paths({ tasks: [validTask({ schedule: { type: 'once', at: '2026-09-22' } })] })).toContain(
      'tasks[0].schedule.at',
    )
  })

  it('interval 的 every 拒绝亚分钟（FR-2 第 1 条）', () => {
    expect(
      paths({ tasks: [validTask({ schedule: { type: 'interval', every: '30s' } })] }),
    ).toContain('tasks[0].schedule.every')
  })

  it('interval 的 anchor 枚举（已移除 fixed-grid）', () => {
    expect(
      paths({ tasks: [validTask({ schedule: { type: 'interval', every: '30m', anchor: 'fixed-grid' } })] }),
    ).toContain('tasks[0].schedule.anchor')
  })

  it('windowed-interval 必须有 window.start / window.end', () => {
    expect(
      paths({
        tasks: [
          validTask({
            schedule: { type: 'windowed-interval', every: '30m', window: { start: '08:00' } },
          }),
        ],
      }),
    ).toContain('tasks[0].schedule.window.end')
  })

  it('windowed-interval 的 align 枚举（已移除 fixed-grid）', () => {
    expect(
      paths({
        tasks: [
          validTask({
            schedule: {
              type: 'windowed-interval',
              every: '30m',
              window: { start: '08:00', end: '16:00' },
              align: 'fixed-grid',
            },
          }),
        ],
      }),
    ).toContain('tasks[0].schedule.align')
  })
})

describe('normalizeHeartbeatConfig — 文案占位符错误也带路径', () => {
  it('未知变量报在 tasks[0].payload.text 下', () => {
    const list = issues({ tasks: [validTask({ payload: { text: '现在是{now}' } })] })
    expect(list[0]?.path).toBe('tasks[0].payload.text')
    expect(list[0]?.message).toContain('now')
  })

  it('一次报出文案里的多个占位符错误', () => {
    const list = issues({ tasks: [validTask({ payload: { text: '{now} 和 {then}' } })] })
    expect(list).toHaveLength(2)
  })

  it('编译好的节点树会随配置一起产出', () => {
    const cfg = config({ tasks: [validTask({ payload: { text: '现在是{time}' } })] })
    expect(cfg.tasks[0]?.payload.text).toBe('现在是{time}')
    expect(cfg.tasks[0]?.payload.nodes).toEqual([
      { kind: 'text', value: '现在是' },
      { kind: 'variable', name: 'time', param: null, offset: 3 },
    ])
  })
})

describe('normalizeHeartbeatConfig — once 过期（D-8 ① / FR-1 验收第 2 条）', () => {
  it('过去的 once 不报配置错误，而是给出 warning 与 initialError', () => {
    const result = normalizeHeartbeatConfig(
      { tasks: [validTask({ schedule: { type: 'once', at: '2026-09-20 08:00' } })] },
      OPTIONS,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]?.path).toBe('tasks[0].schedule.at')
    expect(result.config.tasks[0]?.initialError).toBe('once-expired')
  })

  it('未来的 once 没有 warning，也没有 initialError', () => {
    const result = normalizeHeartbeatConfig(
      { tasks: [validTask({ schedule: { type: 'once', at: '2026-09-22 08:00' } })] },
      OPTIONS,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.warnings).toHaveLength(0)
    expect(result.config.tasks[0]?.initialError).toBeNull()
  })
})
