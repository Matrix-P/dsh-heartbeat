import { describe, expect, it } from 'vitest'

import { createFakeClock, createSystemClock, MAX_TIMER_DELAY_MS } from '../../src/runtime/clock.js'

describe('createFakeClock — 可控时间源（需求 8.5：时间源必须可注入）', () => {
  it('从指定起点开始', () => {
    expect(createFakeClock(1_000).now()).toBe(1_000)
    expect(createFakeClock().now()).toBe(0)
  })

  it('advance 到点才触发', () => {
    const clock = createFakeClock(0)
    const fired: number[] = []
    clock.schedule(500, () => fired.push(clock.now()))

    clock.advance(499)
    expect(fired).toEqual([])

    clock.advance(1)
    expect(fired).toEqual([500])
  })

  it('已到点的回调在下一次 advance 时触发', () => {
    const clock = createFakeClock(1_000)
    let called = false
    clock.schedule(500, () => {
      called = true
    })

    clock.advance(0)
    expect(called).toBe(true)
    expect(clock.now()).toBe(1_000)
  })

  it('返回的取消函数生效', () => {
    const clock = createFakeClock(0)
    let called = false
    const cancel = clock.schedule(100, () => {
      called = true
    })
    cancel()
    clock.advance(1_000)
    expect(called).toBe(false)
  })

  it('多个定时器按时间顺序触发', () => {
    const clock = createFakeClock(0)
    const order: string[] = []
    clock.schedule(300, () => order.push('c'))
    clock.schedule(100, () => order.push('a'))
    clock.schedule(200, () => order.push('b'))

    clock.advance(1_000)
    expect(order).toEqual(['a', 'b', 'c'])
  })

  it('回调里新安排的更早定时器会在同一次 advance 内触发', () => {
    const clock = createFakeClock(0)
    const order: string[] = []

    clock.schedule(1_000, () => {
      order.push('outer')
      clock.schedule(100, () => order.push('inner'))
    })

    clock.advance(2_000)
    // outer 在 t=1000 触发；inner 被安排到 t=100（已过去）→ 紧接着触发
    expect(order).toEqual(['outer', 'inner'])
    expect(clock.now()).toBe(2_000)
  })

  it('pending 反映挂起数量', () => {
    const clock = createFakeClock(0)
    expect(clock.pending).toBe(0)

    clock.schedule(100, () => {})
    clock.schedule(200, () => {})
    expect(clock.pending).toBe(2)

    clock.advance(100)
    expect(clock.pending).toBe(1)

    clock.advance(1_000)
    expect(clock.pending).toBe(0)
  })
})

describe('FakeClock.sleep — 模拟进程/机器休眠（定时器迟到触发）', () => {
  it('休眠期间到期的回调醒来才触发，看到的是「醒来时刻」而不是「原定时刻」', () => {
    const clock = createFakeClock(0)
    const seen: number[] = []
    clock.schedule(1_000, () => seen.push(clock.now()))

    clock.sleep(60_000)

    // 迟到 59 秒 —— 这正是 missed 判定需要的输入
    expect(seen).toEqual([60_000])
    expect(clock.now()).toBe(60_000)
  })

  it('休眠跨越多个定时器时全部补触发，顺序保持', () => {
    const clock = createFakeClock(0)
    const order: string[] = []
    clock.schedule(1_000, () => order.push('a'))
    clock.schedule(2_000, () => order.push('b'))

    clock.sleep(10_000)

    expect(order).toEqual(['a', 'b'])
  })

  it('sleep(0) 等价于「立刻检查到期」', () => {
    const clock = createFakeClock(5_000)
    let called = false
    clock.schedule(1_000, () => {
      called = true
    })

    clock.sleep(0)

    expect(called).toBe(true)
    expect(clock.now()).toBe(5_000)
  })
})

describe('createSystemClock', () => {
  it('默认走真实时钟与真实定时器', () => {
    const clock = createSystemClock()
    const before = Date.now()
    expect(clock.now()).toBeGreaterThanOrEqual(before)
  })

  it('普通延时直接透传', () => {
    const delays: number[] = []
    const clock = createSystemClock({
      now: () => 0,
      setTimeout: ((_cb: () => void, delay?: number) => {
        delays.push(delay ?? 0)
        return 1 as unknown as ReturnType<typeof setTimeout>
      }) as unknown as typeof setTimeout,
      clearTimeout: (() => undefined) as unknown as typeof clearTimeout,
    })

    const cancel = clock.schedule(5_000, () => {})
    expect(delays).toEqual([5_000])
    cancel()
  })

  it('超过 MAX_TIMER_DELAY_MS 的延时按上限分段（避免 32 位溢出）', () => {
    const delays: number[] = []
    const clock = createSystemClock({
      now: () => 0,
      setTimeout: ((_cb: () => void, delay?: number) => {
        delays.push(delay ?? 0)
        return 1 as unknown as ReturnType<typeof setTimeout>
      }) as unknown as typeof setTimeout,
      clearTimeout: (() => undefined) as unknown as typeof clearTimeout,
    })

    const cancel = clock.schedule(MAX_TIMER_DELAY_MS + 5_000, () => {})
    expect(delays).toEqual([MAX_TIMER_DELAY_MS])
    expect(MAX_TIMER_DELAY_MS).toBe(2_147_483_647)
    cancel()
  })

  it('定时器被提前唤醒时会重新 arm，不会漏触发', () => {
    let pending: Array<() => void> = []
    let current = 0
    let fired = 0

    const clock = createSystemClock({
      now: () => current,
      setTimeout: ((cb: () => void) => {
        pending.push(cb)
        return 1 as unknown as ReturnType<typeof setTimeout>
      }) as unknown as typeof setTimeout,
      clearTimeout: (() => undefined) as unknown as typeof clearTimeout,
    })

    clock.schedule(1_000, () => {
      fired += 1
    })

    // 模拟被提前唤醒（current 仍是 0）
    const first = pending[0]
    pending = []
    first?.()
    expect(fired).toBe(0)
    expect(pending.length).toBe(1) // 已经重新 arm

    // 时间真的到了再唤醒
    current = 1_000
    const second = pending[0]
    pending = []
    second?.()
    expect(fired).toBe(1)
  })

  it('取消后不再触发', () => {
    let pending: Array<() => void> = []
    let fired = 0

    const clock = createSystemClock({
      now: () => 0,
      setTimeout: ((cb: () => void) => {
        pending.push(cb)
        return 1 as unknown as ReturnType<typeof setTimeout>
      }) as unknown as typeof setTimeout,
      clearTimeout: (() => undefined) as unknown as typeof clearTimeout,
    })

    const cancel = clock.schedule(100, () => {
      fired += 1
    })
    cancel()
    pending[0]?.()
    expect(fired).toBe(0)
  })
})
