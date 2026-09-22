/**
 * 时间源 seam（技术设计第 5 节）——**坏消息一**：DSH 框架没有可注入时钟。
 *
 * `cordis-plugin-timer` 直接调用全局 `setTimeout` / `Date.now()`，构造参数只有
 * `ctx`，没有任何 clock 注入点；官方插件自己也裸用全局定时器。
 *
 * 因此本模块提供唯一的「时间入口」，并立下纪律：
 *
 * > **除本文件外，任何源文件都不得出现无参 `new Date()` / `Date.now()` /
 * > `setTimeout` / `setInterval`。** 所有求值函数把 `now` 当入参，保证纯函数与可测性。
 *
 * 纯日历运算（`Date.UTC(...)`、带参数的 `new Date(ms)`）不读时钟，允许出现在
 * 其他模块（见 `schedule/calendar.ts`）。
 */

export type Cancel = () => void

export interface Clock {
  /** 当前墙上时间（epoch ms） */
  now(): number
  /** 安排在 `at` 时刻回调一次；返回取消函数 */
  schedule(at: number, callback: () => void): Cancel
}

/**
 * `setTimeout` 的 32 位上限。超过它的延时会**立即**触发，必须分段。
 * 与官方 `dsh-schedule` 的 `MAX_TIMER_DELAY_MS` 取值一致。
 */
export const MAX_TIMER_DELAY_MS = 2_147_483_647

export interface SystemClockDeps {
  readonly now?: () => number
  readonly setTimeout?: typeof setTimeout
  readonly clearTimeout?: typeof clearTimeout
}

/** 生产用时钟：真实墙钟 + 真实定时器（超长延时自动分段）。 */
export function createSystemClock(deps: SystemClockDeps = {}): Clock {
  const now = deps.now ?? ((): number => Date.now())
  const scheduleTimer = deps.setTimeout ?? setTimeout
  const cancelTimer = deps.clearTimeout ?? clearTimeout

  return {
    now,
    schedule(at, callback) {
      let cancelled = false
      let handle: ReturnType<typeof setTimeout> | null = null

      const arm = (target: number): void => {
        if (cancelled) return
        const delay = Math.max(0, target - now())
        handle = scheduleTimer(
          () => {
            if (cancelled) return
            // 被提前唤醒，或刚才是被上限截断的一段：时间还没到就继续等
            if (target - now() > 0) {
              arm(target)
              return
            }
            callback()
          },
          Math.min(delay, MAX_TIMER_DELAY_MS),
        )
      }

      arm(at)

      return () => {
        cancelled = true
        if (handle !== null) cancelTimer(handle)
      }
    },
  }
}

export interface FakeClock extends Clock {
  /** 推进虚拟时间，并触发沿途所有到期回调（含回调中新安排的）——模拟**进程醒着** */
  advance(ms: number): void
  /**
   * 模拟**进程 / 机器休眠**：时间直接跳过 `ms`，期间到期的定时器醒来后集中补触发，
   * 且回调里 `now()` 是**醒来时刻**，因此能算出「迟到量」。
   *
   * 这正是 `missed` 补偿策略（需求第 7 章）需要的输入：`advance` 会让定时器准点触发
   * （迟到量恒为 0），而 `sleep` 才会产生迟到量。
   */
  sleep(ms: number): void
  /** 当前挂起的定时器数量 */
  readonly pending: number
}

interface FakeTimer {
  readonly at: number
  readonly callback: () => void
}

/** 单次 `advance` 内允许的最大触发轮数，防止回调互相安排造成死循环。 */
const MAX_ADVANCE_STEPS = 100_000

/** 测试用时钟：完全由 `advance` 驱动，`now` 与 `schedule` 都是确定性的。 */
export function createFakeClock(start = 0): FakeClock {
  let current = start
  let nextId = 1
  const timers = new Map<number, FakeTimer>()

  function earliestDue(limit: number): number | null {
    let earliest: number | null = null
    for (const timer of timers.values()) {
      if (timer.at <= limit && (earliest === null || timer.at < earliest)) earliest = timer.at
    }
    return earliest
  }

  function runDue(): void {
    for (let steps = 0; ; steps += 1) {
      if (steps >= MAX_ADVANCE_STEPS) {
        throw new Error('FakeClock 触发轮数过多：疑似回调互相安排造成死循环')
      }

      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= current)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])

      const first = due[0]
      if (first === undefined) return
      timers.delete(first[0])
      first[1].callback()
    }
  }

  return {
    now: () => current,

    schedule(at, callback) {
      const id = nextId
      nextId += 1
      timers.set(id, { at, callback })
      return () => {
        timers.delete(id)
      }
    },

    advance(ms) {
      const target = current + ms

      for (let steps = 0; ; steps += 1) {
        const next = earliestDue(target)
        if (next === null) break
        current = Math.max(current, next)
        runDue()

        if (steps >= MAX_ADVANCE_STEPS) {
          throw new Error('FakeClock.advance 触发轮数过多：疑似回调互相安排造成死循环')
        }
      }

      current = target
      runDue()
    },

    sleep(ms) {
      // 先跳时间、再触发：回调里看到的是「醒来时刻」，迟到量因此非零
      current += ms
      runDue()
    },

    get pending() {
      return timers.size
    },
  }
}
