import { describe, expect, it } from 'vitest'

import type { NormalizedHeartbeatConfig } from '../../src/config.js'
import { normalizeHeartbeatConfig } from '../../src/config.js'
import type { DeliveryPort, OutboundMessage } from '../../src/delivery/deliver.js'
import { createFakeClock, type FakeClock } from '../../src/runtime/clock.js'
import type { Orchestrator, OrchestratorLog, TaskStorePort } from '../../src/runtime/orchestrator.js'
import { createOrchestrator } from '../../src/runtime/orchestrator.js'
import type { TaskState } from '../../src/runtime/task-state.js'

const TZ = 'Asia/Shanghai'
/** 上海 2026-09-21 08:00（周一） */
const NOW = Date.UTC(2026, 8, 21, 0, 0, 0)
const MIN = 60_000
const HOUR = 3_600_000

function buildConfig(
  tasks: readonly unknown[],
  overrides: Record<string, unknown> = {},
): NormalizedHeartbeatConfig {
  const result = normalizeHeartbeatConfig({ ...overrides, tasks }, { now: NOW, systemTimezone: TZ })
  if (!result.ok) {
    throw new Error(`测试配置不合法：${result.errors.map((e) => `${e.path}: ${e.message}`).join(' / ')}`)
  }
  return result.config
}

const dailyTask = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'daily',
  session: 's1',
  schedule: { type: 'daily', at: '08:30' },
  payload: { text: '到点了 {time}' },
  ...overrides,
})

const intervalTask = (overrides: Record<string, unknown> = {}): Record<string, unknown> =>
  dailyTask({
    id: 'ping',
    schedule: { type: 'interval', every: '30m', anchor: 'enable-time' },
    payload: { text: '在吗 {time}' },
    ...overrides,
  })

interface Flags {
  warmUpError: unknown
}

interface Env {
  readonly clock: FakeClock
  readonly orchestrator: Orchestrator
  readonly store: Map<string, TaskState>
  readonly delivered: Array<{ sessionId: string; message: OutboundMessage }>
  readonly logs: OrchestratorLog[]
  readonly live: Set<string>
  readonly roots: Set<string>
  readonly subagents: Set<string>
  readonly statuses: Map<string, 'idle' | 'running'>
  readonly flags: Flags
}

function createEnv(initialState?: Record<string, TaskState>): Env {
  const clock = createFakeClock(NOW)
  const store = new Map<string, TaskState>(Object.entries(initialState ?? {}))
  const delivered: Array<{ sessionId: string; message: OutboundMessage }> = []
  const logs: OrchestratorLog[] = []
  const live = new Set<string>(['s1'])
  const roots = new Set<string>(['s1'])
  const subagents = new Set<string>()
  const statuses = new Map<string, 'idle' | 'running'>([['s1', 'idle']])
  const flags: Flags = { warmUpError: undefined }

  const statePort: TaskStorePort = {
    load: (taskId) => store.get(taskId),
    save: (taskId, state) => {
      store.set(taskId, state)
    },
    remove: (taskId) => {
      store.delete(taskId)
    },
  }

  const delivery: DeliveryPort = {
    isLive: (id) => live.has(id),
    isRoot: (id) => roots.has(id),
    isSubagentSession: (id) => subagents.has(id),
    statusOf: (id) => statuses.get(id),
    warmUp: async (id) => {
      if (flags.warmUpError !== undefined) throw flags.warmUpError
      live.add(id)
      roots.add(id)
      statuses.set(id, 'idle')
    },
    followup: (sessionId, message) => {
      delivered.push({ sessionId, message })
    },
    inject: (sessionId, message) => {
      delivered.push({ sessionId, message })
    },
  }

  const orchestrator = createOrchestrator({
    clock,
    delivery,
    store: statePort,
    rng: { int: (min) => min },
    onLog: (entry) => {
      logs.push(entry)
    },
  })

  return { clock, orchestrator, store, delivered, logs, live, roots, subagents, statuses, flags }
}

describe('Orchestrator — 装配与初始状态', () => {
  it('applyConfig 为新任务写入 anchorAt = 当前时刻', () => {
    const env = createEnv()
    env.orchestrator.applyConfig(buildConfig([dailyTask()]))
    expect(env.store.get('daily')?.anchorAt).toBe(NOW)
  })

  it('持久化状态里已有 anchorAt 时，热加载不会把它重置', () => {
    const persisted: TaskState = {
      fireCount: 7,
      lastFiredAt: NOW - HOUR,
      lastResult: 'queued',
      noReplyStreak: 1,
      suspended: false,
      suspendReason: null,
      suspendedAt: null,
      completedAt: null,
      lastUserMsgAt: null,
      lastIdleAt: null,
      anchorAt: NOW - 10 * HOUR,
      errorReason: null,
    }
    const env = createEnv({ daily: persisted })
    env.orchestrator.applyConfig(buildConfig([dailyTask()]))

    expect(env.store.get('daily')?.anchorAt).toBe(NOW - 10 * HOUR)
    expect(env.store.get('daily')?.fireCount).toBe(7)
  })

  it('停用→启用会重置 anchorAt 并清零无回应计数（T11）', () => {
    const env = createEnv()
    env.orchestrator.applyConfig(buildConfig([dailyTask()]))
    env.orchestrator.applyConfig(buildConfig([dailyTask({ enabled: false })]))
    env.clock.advance(5 * MIN)
    env.orchestrator.applyConfig(buildConfig([dailyTask({ enabled: true })]))

    const state = env.store.get('daily')
    expect(state?.anchorAt).toBe(NOW + 5 * MIN)
    expect(state?.noReplyStreak).toBe(0)
  })

  it('删除任务会清掉持久化状态', () => {
    const env = createEnv()
    env.orchestrator.applyConfig(buildConfig([dailyTask()]))
    expect(env.store.has('daily')).toBe(true)

    env.orchestrator.applyConfig(buildConfig([]))
    expect(env.store.has('daily')).toBe(false)
  })
})

describe('Orchestrator — 排程与准时投递（T8）', () => {
  it('daily 08:30 在上海时区对应 00:30Z', () => {
    const env = createEnv()
    env.orchestrator.applyConfig(buildConfig([dailyTask()]))
    env.orchestrator.start()

    expect(env.orchestrator.snapshot()[0]?.nextFireAt).toBe(NOW + 30 * MIN)
  })

  it('到点准时投递并写回状态（T8）', async () => {
    const env = createEnv()
    env.orchestrator.applyConfig(buildConfig([dailyTask()]))
    env.orchestrator.start()

    env.clock.advance(30 * MIN)
    await env.orchestrator.whenIdle()

    expect(env.delivered).toHaveLength(1)
    expect(env.delivered[0]?.sessionId).toBe('s1')
    // {time} 在触发时求值（FR-7 第 2 条）
    expect(env.delivered[0]?.message.text).toBe('到点了 08:30')

    const state = env.store.get('daily')
    expect(state?.fireCount).toBe(1)
    expect(state?.lastFiredAt).toBe(NOW + 30 * MIN)
    expect(state?.lastResult).toBe('queued')

    // 次日同一时刻
    expect(env.orchestrator.snapshot()[0]?.nextFireAt).toBe(NOW + 24 * HOUR + 30 * MIN)
  })

  it('组件全局关闭时不排程', () => {
    const env = createEnv()
    env.orchestrator.applyConfig(buildConfig([dailyTask()], { enabled: false }))
    env.orchestrator.start()

    expect(env.orchestrator.snapshot()[0]?.status).toBe('disabled')
    expect(env.orchestrator.snapshot()[0]?.nextFireAt).toBeNull()
  })
})

describe('Orchestrator — once 任务（T3 / T4）', () => {
  it('T3：过期 once 以 ERROR 状态存在，且不排程', async () => {
    const env = createEnv()
    env.orchestrator.applyConfig(
      buildConfig([dailyTask({ id: 'once', schedule: { type: 'once', at: '2026-09-20 08:00' } })]),
    )
    env.orchestrator.start()

    const snapshot = env.orchestrator.snapshot()[0]
    expect(snapshot?.status).toBe('error')
    expect(snapshot?.errorReason).toBe('once-expired')
    expect(snapshot?.nextFireAt).toBeNull()

    env.clock.advance(24 * HOUR)
    await env.orchestrator.whenIdle()
    expect(env.delivered).toHaveLength(0)
  })

  it('T4：once 投递一次后转 completed；重启后（新编排器 + 同一份持久化状态）不再触发', async () => {
    const env = createEnv()
    const schedule = { type: 'once', at: '2026-09-21 08:10' }
    env.orchestrator.applyConfig(buildConfig([dailyTask({ id: 'once', schedule })]))
    env.orchestrator.start()

    env.clock.advance(10 * MIN)
    await env.orchestrator.whenIdle()

    expect(env.delivered).toHaveLength(1)
    expect(env.orchestrator.snapshot()[0]?.status).toBe('completed')
    expect(env.store.get('once')?.completedAt).toBe(NOW + 10 * MIN)

    const restarted = createEnv({ once: env.store.get('once') as TaskState })
    restarted.orchestrator.applyConfig(buildConfig([dailyTask({ id: 'once', schedule })]))
    restarted.orchestrator.start()
    restarted.clock.advance(24 * HOUR)
    await restarted.orchestrator.whenIdle()

    expect(restarted.delivered).toHaveLength(0)
    expect(restarted.orchestrator.snapshot()[0]?.status).toBe('completed')
  })
})

describe('Orchestrator — FR-8 空闲基准（T23 / T24）', () => {
  it('T23：模型说完会刷新 lastIdleAt 并以它为基准重排', async () => {
    const env = createEnv()
    env.orchestrator.applyConfig(buildConfig([intervalTask()]))
    env.orchestrator.start()

    env.clock.advance(30 * MIN)
    await env.orchestrator.whenIdle()
    expect(env.store.get('ping')?.fireCount).toBe(1)

    // 模型在 08:37 说完
    env.clock.advance(7 * MIN)
    env.orchestrator.noteAgentIdle('s1', env.clock.now())

    expect(env.store.get('ping')?.lastIdleAt).toBe(NOW + 37 * MIN)
    expect(env.orchestrator.snapshot()[0]?.nextFireAt).toBe(NOW + 67 * MIN)
  })

  it('T24：lastIdleAt 从持久化恢复，重启后不提前触发', () => {
    const persisted: TaskState = {
      fireCount: 3,
      lastFiredAt: NOW - 10 * MIN,
      lastResult: 'queued',
      noReplyStreak: 0,
      suspended: false,
      suspendReason: null,
      suspendedAt: null,
      completedAt: null,
      lastUserMsgAt: null,
      lastIdleAt: NOW - 2 * MIN,
      anchorAt: NOW - 6 * HOUR,
      errorReason: null,
    }

    const env = createEnv({ ping: persisted })
    env.orchestrator.applyConfig(buildConfig([intervalTask()]))
    env.orchestrator.start()

    // base = lastIdleAt = NOW - 2min；下一格 = base + 30min = NOW + 28min
    expect(env.orchestrator.snapshot()[0]?.nextFireAt).toBe(NOW + 28 * MIN)
  })

  it('模型正在输出时不排程，状态仍是 armed 并标记 supersededBy（T28 语义）', () => {
    const env = createEnv()
    env.orchestrator.applyConfig(buildConfig([intervalTask()]))
    env.orchestrator.start()
    expect(env.orchestrator.snapshot()[0]?.nextFireAt).not.toBeNull()

    env.statuses.set('s1', 'running')
    env.orchestrator.reschedule()

    const snapshot = env.orchestrator.snapshot()[0]
    expect(snapshot?.nextFireAt).toBeNull()
    expect(snapshot?.supersededBy).toBe('agent-busy')
    expect(snapshot?.status).toBe('armed')
  })
})

describe('Orchestrator — 回应恢复（FR-5）', () => {
  it('用户发言 → 清零 streak、解除静默、以该时刻为基准重排', async () => {
    const env = createEnv()
    env.orchestrator.applyConfig(
      buildConfig([intervalTask({ schedule: { type: 'interval', every: '30m' }, noReply: { max: 1 } })]),
    )
    env.orchestrator.start()

    env.clock.advance(30 * MIN)
    await env.orchestrator.whenIdle()

    env.clock.advance(30 * MIN)
    await env.orchestrator.whenIdle()
    expect(env.orchestrator.snapshot()[0]?.status).toBe('suspended')

    env.clock.advance(5 * MIN)
    env.orchestrator.noteUserActivity('s1', env.clock.now())

    const snapshot = env.orchestrator.snapshot()[0]
    expect(snapshot?.status).toBe('armed')
    expect(snapshot?.noReplyStreak).toBe(0)
    expect(snapshot?.suspendReason).toBeNull()
    // 以回复时刻（NOW+65min）为基准
    expect(snapshot?.nextFireAt).toBe(NOW + 95 * MIN)
  })

  it('其它会话的活动不影响本任务', () => {
    const env = createEnv()
    env.orchestrator.applyConfig(buildConfig([dailyTask()]))
    env.orchestrator.start()
    env.orchestrator.noteUserActivity('other-session', NOW + MIN)
    expect(env.store.get('daily')?.lastUserMsgAt).toBeNull()
  })
})

describe('Orchestrator — 失败与冷会话', () => {
  it('T20：目标会话不存在 → 任务转 error 并停止触发', async () => {
    const env = createEnv()
    env.live.delete('s1')
    env.roots.delete('s1')
    env.flags.warmUpError = Object.assign(new Error('not found'), { code: 'session/not-found' })

    env.orchestrator.applyConfig(buildConfig([dailyTask()]))
    env.orchestrator.start()

    env.clock.advance(30 * MIN)
    await env.orchestrator.whenIdle()

    const snapshot = env.orchestrator.snapshot()[0]
    expect(snapshot?.status).toBe('error')
    expect(snapshot?.errorReason).toBe('session-not-found')
    expect(snapshot?.nextFireAt).toBeNull()
    expect(env.delivered).toHaveLength(0)
  })

  it('冷会话跳过时不计数、不推进基准，仍保持 armed 等待上线', async () => {
    const env = createEnv()
    env.live.delete('s1')
    env.roots.delete('s1')

    env.orchestrator.applyConfig(buildConfig([dailyTask()], { coldWake: 'never' }))
    env.orchestrator.start()

    env.clock.advance(30 * MIN)
    await env.orchestrator.whenIdle()

    const state = env.store.get('daily')
    expect(state?.fireCount).toBe(0)
    expect(state?.lastFiredAt).toBeNull()
    expect(state?.lastResult).toBe('skipped')
    expect(env.orchestrator.snapshot()[0]?.status).toBe('armed')
    expect(env.orchestrator.snapshot()[0]?.nextFireAt).toBe(NOW + 24 * HOUR + 30 * MIN)
  })

  it('热加载修正目标会话后，ERROR 会被清掉', async () => {
    const env = createEnv()
    env.live.delete('s1')
    env.roots.delete('s1')
    env.flags.warmUpError = Object.assign(new Error('not found'), { code: 'session/not-found' })

    env.orchestrator.applyConfig(buildConfig([dailyTask()]))
    env.orchestrator.start()
    env.clock.advance(30 * MIN)
    await env.orchestrator.whenIdle()
    expect(env.orchestrator.snapshot()[0]?.status).toBe('error')

    env.flags.warmUpError = undefined
    env.live.add('s2')
    env.roots.add('s2')
    env.statuses.set('s2', 'idle')
    env.orchestrator.applyConfig(buildConfig([dailyTask({ session: 's2' })]))

    const snapshot = env.orchestrator.snapshot()[0]
    expect(snapshot?.status).toBe('armed')
    expect(snapshot?.errorReason).toBeNull()
  })
})

describe('Orchestrator — 状态查询与日志（FR-6）', () => {
  it('snapshot 暴露 FR-6 第 1 条要求的字段', () => {
    const env = createEnv()
    env.orchestrator.applyConfig(buildConfig([dailyTask()]))
    env.orchestrator.start()

    expect(env.orchestrator.snapshot()[0]).toMatchObject({
      id: 'daily',
      name: 'daily',
      status: 'armed',
      fireCount: 0,
      noReplyStreak: 0,
      suspendReason: null,
      errorReason: null,
      supersededBy: null,
    })
    expect(env.orchestrator.snapshot()[0]?.nextFireAt).toBe(NOW + 30 * MIN)
  })

  it('每次触发都产出结构化日志（FR-6 第 3 条）', async () => {
    const env = createEnv()
    env.orchestrator.applyConfig(buildConfig([dailyTask()]))
    env.orchestrator.start()

    env.clock.advance(30 * MIN)
    await env.orchestrator.whenIdle()

    expect(env.logs).toHaveLength(1)
    expect(env.logs[0]).toMatchObject({
      taskId: 'daily',
      session: 's1',
      at: NOW + 30 * MIN,
      result: 'queued',
    })
  })
})

describe('Orchestrator — 手动触发（FR-6 第 2 条）', () => {
  it('fireNow 不计入 fireCount，也不影响 nextFireAt', async () => {
    const env = createEnv()
    env.orchestrator.applyConfig(buildConfig([dailyTask()]))
    env.orchestrator.start()

    const before = env.orchestrator.snapshot()[0]?.nextFireAt
    await env.orchestrator.fireNow('daily')

    expect(env.delivered).toHaveLength(1)
    expect(env.store.get('daily')?.fireCount).toBe(0)
    expect(env.store.get('daily')?.lastResult).toBe('manual')
    expect(env.orchestrator.snapshot()[0]?.nextFireAt).toBe(before)
  })
})

describe('Orchestrator — 静默不投递', () => {
  it('静默后到点不再投递，只更新 streak', async () => {
    const env = createEnv()
    env.orchestrator.applyConfig(
      buildConfig([intervalTask({ noReply: { max: 1 } })]),
    )
    env.orchestrator.start()

    env.clock.advance(30 * MIN)
    await env.orchestrator.whenIdle()
    expect(env.delivered).toHaveLength(1)

    env.clock.advance(30 * MIN)
    await env.orchestrator.whenIdle()
    expect(env.delivered).toHaveLength(1)
    expect(env.orchestrator.snapshot()[0]?.status).toBe('suspended')
    // 静默后不再排程
    expect(env.orchestrator.snapshot()[0]?.nextFireAt).toBeNull()
  })
})

describe('Orchestrator — 错过触发补偿（T19 / 需求第 7 章）', () => {
  it('休眠跨越触发点：默认 missed=skip，不补发', async () => {
    const env = createEnv()
    env.orchestrator.applyConfig(buildConfig([intervalTask()]))
    env.orchestrator.start()

    // 机器休眠 2 小时（跨过 4 个 30 分钟触发点）
    env.clock.sleep(2 * HOUR)
    await env.orchestrator.whenIdle()

    expect(env.delivered).toHaveLength(0)
    expect(env.store.get('ping')?.fireCount).toBe(0)
    // 恢复后按当前时刻重算，指向未来的下一格
    expect(env.orchestrator.snapshot()[0]?.nextFireAt).toBe(NOW + 2.5 * HOUR)
  })

  it('missed=fire-once：只补发一次，绝不补发多次（T19）', async () => {
    const env = createEnv()
    env.orchestrator.applyConfig(buildConfig([intervalTask({ missed: 'fire-once' })]))
    env.orchestrator.start()

    env.clock.sleep(2 * HOUR) // 跨过 4 个触发点，但只应补 1 次
    await env.orchestrator.whenIdle()

    expect(env.delivered).toHaveLength(1)
    expect(env.store.get('ping')?.fireCount).toBe(1)
  })

  it('迟到只在宽限内（几秒）→ 正常投递，不算错过', async () => {
    const env = createEnv()
    env.orchestrator.applyConfig(buildConfig([intervalTask()]))
    env.orchestrator.start()

    // 进程没休眠，只是事件循环卡了一下
    env.clock.sleep(30 * MIN + 3_000)
    await env.orchestrator.whenIdle()

    expect(env.delivered).toHaveLength(1)
  })

  it('once 任务运行中错过 → 默认 skip 时直接置 completed，不投递', async () => {
    const env = createEnv()
    env.orchestrator.applyConfig(
      buildConfig([dailyTask({ id: 'once', schedule: { type: 'once', at: '2026-09-21 08:10' } })]),
    )
    env.orchestrator.start()

    env.clock.sleep(HOUR) // 睡过头 1 小时
    await env.orchestrator.whenIdle()

    expect(env.delivered).toHaveLength(0)
    expect(env.orchestrator.snapshot()[0]?.status).toBe('completed')
  })

  it('手动触发不受错过判定影响', async () => {
    const env = createEnv()
    env.orchestrator.applyConfig(buildConfig([intervalTask()]))
    env.orchestrator.start()

    env.clock.sleep(2 * HOUR)
    await env.orchestrator.whenIdle()
    expect(env.delivered).toHaveLength(0)

    await env.orchestrator.fireNow('ping')
    expect(env.delivered).toHaveLength(1)
  })
})
