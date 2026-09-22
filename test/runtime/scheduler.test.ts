import { describe, expect, it } from 'vitest'

import { createFakeClock, type FakeClock } from '../../src/runtime/clock.js'
import type { Scheduler } from '../../src/runtime/scheduler.js'
import { createScheduler } from '../../src/runtime/scheduler.js'

const START = 1_000_000
const MIN = 60_000

/** 让出若干次微任务，用于观察异步 fire 的交错情况。 */
async function yieldMicrotasks(times = 4): Promise<void> {
  for (let index = 0; index < times; index += 1) await Promise.resolve()
}

interface Harness {
  readonly clock: FakeClock
  readonly scheduler: Scheduler
  readonly fired: Array<{ id: string; at: number }>
  readonly events: string[]
  readonly errors: Array<{ id: string; error: unknown }>
  setNext(id: string, at: number | null): void
}

function createHarness(options: { taskIds?: string[]; asyncFire?: boolean } = {}): Harness {
  const clock = createFakeClock(START)
  const fired: Array<{ id: string; at: number }> = []
  const events: string[] = []
  const errors: Array<{ id: string; error: unknown }> = []
  const taskIds = [...(options.taskIds ?? [])]
  const nextFire = new Map<string, number | null>()

  const scheduler = createScheduler({
    clock,
    taskIds: () => taskIds,
    nextFireAt: (taskId) => nextFire.get(taskId) ?? null,
    fire: async (taskId, at) => {
      events.push(`start:${taskId}`)
      if (options.asyncFire === true) await yieldMicrotasks()
      fired.push({ id: taskId, at })
      events.push(`end:${taskId}`)
    },
    onError: (taskId, error) => {
      errors.push({ id: taskId, error })
    },
  })

  return {
    clock,
    scheduler,
    fired,
    events,
    errors,
    setNext: (id, at) => {
      nextFire.set(id, at)
    },
  }
}

describe('Scheduler — 排程', () => {
  it('尚未 start 时不排程', () => {
    const h = createHarness({ taskIds: ['a'] })
    h.setNext('a', START + 1_000)
    h.scheduler.reschedule()
    expect(h.scheduler.nextWakeAt()).toBeNull()
    expect(h.scheduler.running).toBe(false)
  })

  it('start 后 arm 到最早的目标时刻', () => {
    const h = createHarness({ taskIds: ['a', 'b'] })
    h.setNext('a', START + 5_000)
    h.setNext('b', START + 1_000)

    h.scheduler.start()

    expect(h.scheduler.running).toBe(true)
    expect(h.scheduler.nextWakeAt()).toBe(START + 1_000)
    expect(h.scheduler.pendingTaskIds()).toEqual(['b', 'a'])
  })

  it('没有可排程任务时不 arm', () => {
    const h = createHarness({ taskIds: ['a'] })
    h.setNext('a', null)
    h.scheduler.start()
    expect(h.scheduler.nextWakeAt()).toBeNull()
    expect(h.scheduler.pendingTaskIds()).toEqual([])
  })

  it('只触发已到期的任务；重排后指向下一个目标', async () => {
    const h = createHarness({ taskIds: ['a', 'b'] })
    h.setNext('a', START + 1_000)
    h.setNext('b', START + 10_000)
    h.scheduler.start()

    h.clock.advance(1_000)
    await h.scheduler.whenIdle()
    expect(h.fired.map((f) => f.id)).toEqual(['a'])

    h.setNext('a', START + 100_000)
    h.scheduler.reschedule()
    expect(h.scheduler.nextWakeAt()).toBe(START + 10_000)
  })

  it('目标时刻已过时在下一次 wake 立刻触发', async () => {
    const h = createHarness({ taskIds: ['a'] })
    h.setNext('a', START - 5_000)
    h.scheduler.start()

    h.clock.advance(0)
    await h.scheduler.whenIdle()

    expect(h.fired).toEqual([{ id: 'a', at: START }])
  })
})

describe('Scheduler — 唤醒后重读时钟（FR-2 第 3 条：禁止 sleep 累加）', () => {
  it('fire 拿到的是当前真实时刻，而不是原定目标时刻', async () => {
    const h = createHarness({ taskIds: ['a'] })
    h.setNext('a', START + 1_000)
    h.scheduler.start()

    // 模拟机器休眠：时间直接跳过 60 分钟
    h.clock.advance(60 * MIN)
    await h.scheduler.whenIdle()

    expect(h.fired).toHaveLength(1)
    expect(h.fired[0]?.at).toBe(START + 60 * MIN)
  })
})

describe('Scheduler — 串行与重入（需求第 7 章）', () => {
  it('同刻的多个任务串行依次触发，不并发', async () => {
    const h = createHarness({ taskIds: ['beta', 'alpha'], asyncFire: true })
    h.setNext('beta', START + 1_000)
    h.setNext('alpha', START + 1_000)
    h.scheduler.start()

    h.clock.advance(1_000)
    await h.scheduler.whenIdle()

    // 同刻任务保持配置顺序（beta 在前），且严格一个跑完再跑下一个
    expect(h.events).toEqual(['start:beta', 'end:beta', 'start:alpha', 'end:alpha'])
  })

  it('触发仍在进行时再次 wake，不会让同一任务重入', async () => {
    const clock = createFakeClock(START)
    let starts = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    const scheduler = createScheduler({
      clock,
      taskIds: () => ['a'],
      nextFireAt: () => START + 1_000,
      fire: async () => {
        starts += 1
        await gate
      },
    })

    scheduler.start()
    clock.advance(1_000)
    await yieldMicrotasks()

    // 第一次触发还卡在 gate 上；此时重排并再次推进
    scheduler.reschedule()
    clock.advance(0)
    await yieldMicrotasks()

    expect(starts).toBe(1)

    release()
    await scheduler.whenIdle()
    expect(starts).toBe(1)
  })

  it('单个任务抛错不影响其他任务，并上报 onError', async () => {
    const clock = createFakeClock(START)
    const fired: string[] = []
    const errors: Array<{ id: string; error: unknown }> = []

    const scheduler = createScheduler({
      clock,
      taskIds: () => ['boom', 'fine'],
      nextFireAt: () => START + 1_000,
      fire: (taskId) => {
        if (taskId === 'boom') throw new Error('投递失败')
        fired.push(taskId)
      },
      onError: (id, error) => {
        errors.push({ id, error })
      },
    })

    scheduler.start()
    clock.advance(1_000)
    await scheduler.whenIdle()

    expect(errors).toHaveLength(1)
    expect(errors[0]?.id).toBe('boom')
    expect(fired).toEqual(['fine'])
  })

  it('nextFireAt 抛错时按「不排程」处理并上报，不影响其他任务', async () => {
    const clock = createFakeClock(START)
    const errors: string[] = []

    const scheduler = createScheduler({
      clock,
      taskIds: () => ['broken', 'fine'],
      nextFireAt: (taskId) => {
        if (taskId === 'broken') throw new Error('缺少计时基准')
        return START + 5_000
      },
      fire: () => undefined,
      onError: (id) => {
        errors.push(id)
      },
    })

    scheduler.start()

    expect(errors).toContain('broken')
    expect(scheduler.nextWakeAt()).toBe(START + 5_000)
  })
})

describe('Scheduler — 手动 fire（FR-6 第 2 条）', () => {
  it('fireNow 走同一条串行队列，但不依赖计时', async () => {
    const h = createHarness({ taskIds: ['a'] })
    h.setNext('a', START + 100_000)
    h.scheduler.start()

    await h.scheduler.fireNow('a')

    expect(h.fired).toEqual([{ id: 'a', at: START }])
    // 手动触发没有破坏计时排程
    expect(h.scheduler.nextWakeAt()).toBe(START + 100_000)
  })
})

describe('Scheduler — 停止', () => {
  it('stop 后取消定时器，不再触发', () => {
    const h = createHarness({ taskIds: ['a'] })
    h.setNext('a', START + 1_000)
    h.scheduler.start()

    h.scheduler.stop()
    h.clock.advance(10_000)

    expect(h.scheduler.running).toBe(false)
    expect(h.fired).toEqual([])
    expect(h.scheduler.nextWakeAt()).toBeNull()
  })

  it('stop 后 reschedule 不再生效', () => {
    const h = createHarness({ taskIds: ['a'] })
    h.scheduler.start()
    h.scheduler.stop()
    h.setNext('a', START + 1_000)
    h.scheduler.reschedule()
    expect(h.scheduler.nextWakeAt()).toBeNull()
  })
})

describe('Scheduler — 与 FR-8 输出抑制协作（T28）', () => {
  it('模型持续输出期间既不排程也不触发', () => {
    const h = createHarness({ taskIds: ['a'] })
    // nextFireAt 返回 null = 被抑制（agentBusy）
    h.setNext('a', null)
    h.scheduler.start()

    h.clock.advance(40 * MIN)

    expect(h.fired).toEqual([])
    expect(h.scheduler.nextWakeAt()).toBeNull()
  })

  it('模型说完后重新排程，隔满 every 才触发', async () => {
    const h = createHarness({ taskIds: ['a'] })
    h.setNext('a', null)
    h.scheduler.start()
    h.clock.advance(40 * MIN)
    expect(h.fired).toEqual([])

    // 模型在 t=START+40min 说完 → 下一次 = 说完 + 30min
    const idleAt = START + 40 * MIN
    h.setNext('a', idleAt + 30 * MIN)
    h.scheduler.reschedule()
    expect(h.scheduler.nextWakeAt()).toBe(idleAt + 30 * MIN)

    h.clock.advance(30 * MIN)
    await h.scheduler.whenIdle()
    expect(h.fired.map((f) => f.id)).toEqual(['a'])
  })
})
