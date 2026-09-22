/**
 * 调度器（技术设计 6.1 节）。
 *
 * 核心设计：**只有一个定时器**。调度器把所有任务的 `nextFireAt` 收上来，
 * arm 到最早的那个；到点后**重新读取时钟**、逐个触发、再重新 arm。
 *
 * 这样同时满足四条需求：
 * - FR-2 第 3 条：绝对时间基准，禁止 `sleep(interval)` 累加（唤醒后重读时钟）
 * - 8.2：100 个任务也只有一个定时器，CPU 可忽略
 * - FR-6 第 6 条：开关变更后 `reschedule()` 立即重排
 * - 需求第 7 章：同刻任务**串行**依次触发，单任务失败不影响其他任务
 *
 * 另外维护一个**同步认领集合**（`claimed`），保证同一任务在触发进行中不会被
 * 第二次 wake 重复触发，也不会因此产生空转定时器。
 */

import type { Clock, Cancel } from './clock.js'

/** 触发来源：自动到点 / 手动。编排器据此决定是否计入 `fireCount`（需求第 7 章）。 */
export type FireReason = 'scheduled' | 'manual'

export interface SchedulerDeps {
  readonly clock: Clock
  /** 当前任务 id（**顺序即同刻任务的触发顺序**） */
  readonly taskIds: () => readonly string[]
  /** 推导任务的下一次触发时刻；`null` 表示当前不该排程 */
  readonly nextFireAt: (taskId: string, now: number) => number | null
  /** 到点触发；调度器保证串行且不重入。`targetAt` 是本次唤醒原定排定的目标时刻
   * （手动触发为 `null`），编排器据此算出迟到量以决定是否走 `missed` 补偿。 */
  readonly fire: (
    taskId: string,
    at: number,
    reason: FireReason,
    targetAt: number | null,
  ) => Promise<void> | void
  /** `fire` 或 `nextFireAt` 抛错时的上报出口（默认静默） */
  readonly onError?: (taskId: string, error: unknown) => void
}

export interface Scheduler {
  start(): void
  stop(): void
  /** 配置/状态变化后重排（`stop` 后无效） */
  reschedule(): void
  /** 已排定的最早唤醒时刻；`null` 表示没有排程 */
  nextWakeAt(): number | null
  /** 当前已排程的任务 id（按目标时刻、再按配置顺序） */
  pendingTaskIds(): readonly string[]
  /** 手动触发一次（FR-6 第 2 条）：走同一条串行队列，但不影响计时排程 */
  fireNow(taskId: string): Promise<void>
  /** 等待当前排队中的触发全部结束（测试与停机用） */
  whenIdle(): Promise<void>
  readonly running: boolean
}

interface DueTask {
  readonly taskId: string
  /** 原定排定的目标时刻 */
  readonly at: number
}

export function createScheduler(deps: SchedulerDeps): Scheduler {
  let stopped = true
  let cancelTimer: Cancel | null = null
  let targets = new Map<string, number>()
  /** 已认领（正在或即将触发）的任务 id */
  const claimed = new Set<string>()
  let queue: Promise<void> = Promise.resolve()

  function enqueue(operation: () => Promise<void>): Promise<void> {
    const next = queue.then(operation, operation)
    queue = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  function reportError(taskId: string, error: unknown): void {
    deps.onError?.(taskId, error)
  }

  function computeTargets(now: number): Map<string, number> {
    const result = new Map<string, number>()
    for (const taskId of deps.taskIds()) {
      let at: number | null
      try {
        at = deps.nextFireAt(taskId, now)
      } catch (error) {
        reportError(taskId, error)
        at = null
      }
      if (at !== null) result.set(taskId, at)
    }
    return result
  }

  function cancelTimerIfArmed(): void {
    if (cancelTimer !== null) {
      cancelTimer()
      cancelTimer = null
    }
  }

  function dueTasks(now: number): readonly DueTask[] {
    const order = new Map(deps.taskIds().map((id, index) => [id, index]))
    return [...targets.entries()]
      .filter(([taskId, at]) => at <= now && !claimed.has(taskId))
      .sort(
        (left, right) =>
          left[1] - right[1] || (order.get(left[0]) ?? 0) - (order.get(right[0]) ?? 0),
      )
      .map(([taskId, at]) => ({ taskId, at }))
  }

  function arm(): void {
    cancelTimerIfArmed()
    if (stopped) return

    const now = deps.clock.now()
    targets = computeTargets(now)

    let earliest: number | null = null
    for (const [taskId, at] of targets) {
      if (claimed.has(taskId)) continue
      if (earliest === null || at < earliest) earliest = at
    }
    if (earliest === null) return

    // 已过期的目标用 「now」 排一个 0 延时定时器，让时钟决定何时唤醒
    cancelTimer = deps.clock.schedule(Math.max(earliest, now), () => {
      cancelTimer = null
      wake()
    })
  }

  function runAll(items: readonly DueTask[], reason: FireReason): Promise<void> {
    return enqueue(async () => {
      for (const item of items) {
        if (stopped) break
        try {
          await deps.fire(
            item.taskId,
            deps.clock.now(),
            reason,
            reason === 'manual' ? null : item.at,
          )
        } catch (error) {
          reportError(item.taskId, error)
        } finally {
          claimed.delete(item.taskId)
        }
      }
      arm()
    })
  }

  function wake(): void {
    if (stopped) return

    const due = dueTasks(deps.clock.now())
    if (due.length === 0) {
      arm()
      return
    }

    // 同步认领：即使触发还在进行中，后续 wake 也不会重复认领这些任务
    for (const item of due) claimed.add(item.taskId)
    void runAll(due, 'scheduled')
  }

  return {
    get running() {
      return !stopped
    },

    start() {
      if (!stopped) return
      stopped = false
      arm()
    },

    stop() {
      stopped = true
      cancelTimerIfArmed()
      targets = new Map()
    },

    reschedule() {
      if (stopped) return
      arm()
    },

    nextWakeAt() {
      let earliest: number | null = null
      for (const [taskId, at] of targets) {
        if (claimed.has(taskId)) continue
        if (earliest === null || at < earliest) earliest = at
      }
      return earliest
    },

    pendingTaskIds() {
      const order = new Map(deps.taskIds().map((id, index) => [id, index]))
      return [...targets.entries()]
        .filter(([taskId]) => !claimed.has(taskId))
        .sort(
          (left, right) =>
            left[1] - right[1] || (order.get(left[0]) ?? 0) - (order.get(right[0]) ?? 0),
        )
        .map(([taskId]) => taskId)
    },

    fireNow(taskId) {
      if (stopped) return Promise.resolve()
      claimed.add(taskId)
      return runAll([{ taskId, at: deps.clock.now() }], 'manual')
    },

    whenIdle() {
      return queue
    },
  }
}
