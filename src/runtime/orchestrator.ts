/**
 * 任务编排器 —— 把纯函数内核接线成一个可运行的组件。
 *
 * 它负责四件事：
 * 1. 持有归一化配置与每个任务的运行期状态（状态经 `TaskStorePort` 持久化）；
 * 2. 向调度器提供 `nextFireAt`（把 `next-fire` + `task-state` + FR-8 抑制组合起来）；
 * 3. 实现 `fire`：求值 → 渲染 → 投递 → 写回状态 → 产出结构化日志；
 * 4. 接收两类外部事实：**用户发言**（`api-session/activity`）与**模型说完**
 *    （`agent/status → idle`）。
 *
 * 本模块不直接依赖 DSH：时钟、投递、存储、随机源全部经端口注入，因此可以用假件
 * 做端到端的确定性测试。
 */

import type { NormalizedHeartbeatConfig, NormalizedTask } from '../config.js'
import type { DeliveryPort } from '../delivery/deliver.js'
import { deliver } from '../delivery/deliver.js'
import type { Clock } from './clock.js'
import { lateGraceMs, ScheduleError } from '../schedule/next-fire.js'
import { nextFireAfter } from '../schedule/next-fire.js'
import type { FireReason, Scheduler } from './scheduler.js'
import { createScheduler } from './scheduler.js'
import type { FireResult, TaskConfigFacts, TaskState, TaskStatus } from './task-state.js'
import {
  clearError,
  completeOnce,
  evaluateFire,
  initialTaskState,
  markError,
  onTaskEnabled,
  onUserReply,
  recordDelivery,
  recordIdle,
  statusOf,
} from './task-state.js'
import type { Rng } from '../templating/render.js'
import { renderTemplate } from '../templating/render.js'

/** 运行期状态持久化端口（技术设计 4.1 用 storageDomain 实现）。 */
export interface TaskStorePort {
  load(taskId: string): TaskState | undefined
  save(taskId: string, state: TaskState): void
  remove(taskId: string): void
}

/** 一次触发的结构化日志（FR-6 第 3 条）。 */
export interface OrchestratorLog {
  readonly taskId: string
  readonly session: string
  readonly at: number
  /** `delivered` 已入队 / `suppressed` 因状态不投递 / `skipped` 因会话不可用 / `failed` 投递失败 */
  readonly outcome: 'delivered' | 'suppressed' | 'skipped' | 'failed'
  readonly result: FireResult | null
  readonly reason: string | null
  readonly nextFireAt: number | null
}

/** 状态查询的单条记录（FR-6 第 1 条 / 技术设计 11.3）。 */
export interface TaskSnapshot {
  readonly id: string
  readonly name: string
  readonly status: TaskStatus
  readonly nextFireAt: number | null
  readonly fireCount: number
  readonly noReplyStreak: number
  readonly lastResult: FireResult | null
  readonly lastFiredAt: number | null
  readonly suspendReason: string | null
  readonly suspendedAt: number | null
  readonly errorReason: string | null
  /** 非 null 表示「本该触发但被抑制」，界面据此解释为什么没触发 */
  readonly supersededBy: 'agent-busy' | null
}

export interface OrchestratorDeps {
  readonly clock: Clock
  readonly delivery: DeliveryPort
  readonly store: TaskStorePort
  readonly rng: Rng
  readonly onLog?: (entry: OrchestratorLog) => void
}

export interface Orchestrator {
  /** 应用（或热加载）一份新配置 */
  applyConfig(config: NormalizedHeartbeatConfig): void
  start(): void
  stop(): void
  reschedule(): void
  /** 用户发言（`api-session/activity`） */
  noteUserActivity(sessionId: string, at: number): void
  /** 模型说完（`agent/status → idle`，FR-8） */
  noteAgentIdle(sessionId: string, at: number): void
  fireNow(taskId: string): Promise<void>
  snapshot(): readonly TaskSnapshot[]
  whenIdle(): Promise<void>
}

const EMPTY_CONFIG: NormalizedHeartbeatConfig = {
  enabled: true,
  timezone: 'UTC',
  coldWake: 'session-controller',
  singleInstance: 'warn',
  tasks: [],
}

export function createOrchestrator(deps: OrchestratorDeps): Orchestrator {
  let config: NormalizedHeartbeatConfig = EMPTY_CONFIG
  const tasks = new Map<string, NormalizedTask>()
  const states = new Map<string, TaskState>()
  /** 上一版配置里每个任务的开关与目标会话，用于识别「停用→启用」与「换会话」 */
  const previousEnabled = new Map<string, boolean>()
  const previousSession = new Map<string, string>()

  function stateOf(taskId: string): TaskState {
    const cached = states.get(taskId)
    if (cached !== undefined) return cached

    const loaded = deps.store.load(taskId)
    const state = loaded ?? initialTaskState(null)
    states.set(taskId, state)
    return state
  }

  function save(taskId: string, state: TaskState): void {
    states.set(taskId, state)
    deps.store.save(taskId, state)
  }

  function factsOf(task: NormalizedTask): TaskConfigFacts {
    return {
      enabled: task.enabled,
      noReplyMax: task.noReply.max,
      noReplyWindowMs: task.noReply.windowMs,
    }
  }

  function isAgentBusy(sessionId: string): boolean {
    return deps.delivery.statusOf(sessionId) === 'running'
  }

  /** 推导下一次触发；任何推导失败都视为「不排程」，避免把组件整体拖挂。 */
  function safeNextFire(task: NormalizedTask, state: TaskState, now: number): number | null {
    try {
      return nextFireAfter({
        schedule: task.schedule,
        timezone: task.timezone,
        now,
        anchorAt: state.anchorAt,
        lastFiredAt: state.lastFiredAt,
        lastIdleAt: state.lastIdleAt,
        agentBusy: isAgentBusy(task.session),
      })
    } catch (error) {
      if (error instanceof ScheduleError) return null
      throw error
    }
  }

  function scheduledNextFire(taskId: string, now: number): number | null {
    const task = tasks.get(taskId)
    if (task === undefined) return null

    const state = stateOf(taskId)
    const status = statusOf(factsOf(task), state, config.enabled)
    // 排程前提：只有 ARMED 才计时（DISABLED / ERROR / SUSPENDED / COMPLETED 一律不排）
    if (status !== 'armed') return null

    return safeNextFire(task, state, now)
  }

  /** 渲染用的「本次触发后的下一次」——`{nextFireAt}` 占位符要展示它。 */
  function nextFireAfterThis(task: NormalizedTask, state: TaskState, at: number): number | null {
    try {
      return nextFireAfter({
        schedule: task.schedule,
        timezone: task.timezone,
        now: at,
        anchorAt: state.anchorAt,
        lastFiredAt: at,
        lastIdleAt: state.lastIdleAt,
        agentBusy: false,
      })
    } catch (error) {
      if (error instanceof ScheduleError) return null
      throw error
    }
  }

  function log(entry: OrchestratorLog): void {
    deps.onLog?.(entry)
  }

  async function fireTask(
    taskId: string,
    at: number,
    reason: FireReason,
    targetAt: number | null,
  ): Promise<void> {
    const task = tasks.get(taskId)
    if (task === undefined) return

    const manual = reason === 'manual'
    let state = stateOf(taskId)

    // 手动触发：跳过状态机求值（不计入 streak、不因静默被拒），但仍要投递一次
    if (!manual) {
      const evaluation = evaluateFire(factsOf(task), state, config.enabled, at)
      state = evaluation.state

      if (!evaluation.deliver) {
        save(taskId, state)
        log({
          taskId,
          session: task.session,
          at,
          outcome: 'suppressed',
          result: null,
          reason: evaluation.suppressReason,
          nextFireAt: scheduledNextFire(taskId, at),
        })
        return
      }
    }

    // 错过触发（需求第 7 章）：默认跳过，只有 missed=fire-once 才补发，且**只补一次**
    const lateness = targetAt === null ? 0 : Math.max(0, at - targetAt)
    const isLate = !manual && lateness > lateGraceMs(task.schedule)

    if (isLate && task.missed === 'skip') {
      // once 任务错过后不再有机会，直接置完成（D-8 ②）
      if (task.schedule.kind === 'once') state = completeOnce(state, at)
      save(taskId, state)
      log({
        taskId,
        session: task.session,
        at,
        outcome: 'skipped',
        result: state.lastResult,
        reason: `missed:${lateness}ms`,
        nextFireAt: scheduledNextFire(taskId, at),
      })
      return
    }

    const fireCountForRender = manual ? state.fireCount : state.fireCount + 1
    const text = renderTemplate(task.payload.nodes, {
      now: at,
      timezone: task.timezone,
      task: {
        id: task.id,
        name: task.name,
        fireCount: fireCountForRender,
        noReplyStreak: state.noReplyStreak,
        lastFiredAt: state.lastFiredAt,
        nextFireAt: nextFireAfterThis(task, state, at),
      },
      session: { lastUserMsgAt: state.lastUserMsgAt },
      rng: deps.rng,
    })

    const outcome = await deliver(
      {
        sessionId: task.session,
        text,
        onBusy: task.onBusy,
        coldWake: config.coldWake,
      },
      deps.delivery,
    )

    let logOutcome: OrchestratorLog['outcome'] = 'delivered'
    let logResult: FireResult | null
    let logReason: string | null = null

    switch (outcome.kind) {
      case 'queued':
      case 'injected': {
        state = manual
          ? recordDelivery(state, at, 'manual', { countsAsFire: false })
          : recordDelivery(state, at, 'queued')
        // once 任务投递成功即完成（FR-1 第 4 条）：重启后不再触发
        if (task.schedule.kind === 'once') state = completeOnce(state, at)
        logResult = manual ? 'manual' : 'queued'
        break
      }

      case 'skipped': {
        if (outcome.reason === 'agent-busy') {
          // FR-4 第 3 条：skip 计入一次真实触发
          state = recordDelivery(state, at, 'skipped')
          logOutcome = 'skipped'
          logReason = 'agent-busy'
          logResult = 'skipped'
        } else {
          // 目标会话不可用：不计数、不推进基准，保持逾期等它上线
          state = recordDelivery(state, at, 'skipped', { countsAsFire: false })
          logOutcome = 'skipped'
          logReason = 'not-live'
          logResult = 'skipped'
        }
        break
      }

      case 'failed': {
        // 投递失败不计入「无回应」——否则会把「没送到」当成「用户没回」而误静默
        state = recordDelivery(state, at, 'failed', { countsAsFire: false })
        if (
          outcome.reason === 'session-not-found' ||
          outcome.reason === 'subagent-session' ||
          outcome.reason === 'not-root'
        ) {
          state = markError(state, outcome.reason)
        }
        logOutcome = 'failed'
        logReason = outcome.detail ?? outcome.reason
        logResult = 'failed'
        break
      }
    }

    save(taskId, state)
    log({
      taskId,
      session: task.session,
      at,
      outcome: logOutcome,
      result: logResult,
      reason: logReason,
      nextFireAt: scheduledNextFire(taskId, at),
    })
  }

  const scheduler: Scheduler = createScheduler({
    clock: deps.clock,
    taskIds: () => [...tasks.keys()],
    nextFireAt: scheduledNextFire,
    fire: fireTask,
    onError: (taskId, error) => {
      const session = tasks.get(taskId)?.session ?? ''
      log({
        taskId,
        session,
        at: deps.clock.now(),
        outcome: 'failed',
        result: null,
        reason: error instanceof Error ? error.message : String(error),
        nextFireAt: null,
      })
    },
  })

  function applyConfig(next: NormalizedHeartbeatConfig): void {
    const now = deps.clock.now()
    config = next

    const nextTasks = new Map(next.tasks.map((task) => [task.id, task]))

    for (const taskId of [...tasks.keys()]) {
      if (nextTasks.has(taskId)) continue
      tasks.delete(taskId)
      states.delete(taskId)
      previousEnabled.delete(taskId)
      previousSession.delete(taskId)
      deps.store.remove(taskId)
    }

    for (const task of next.tasks) {
      const isNew = !tasks.has(task.id)
      const wasEnabled = previousEnabled.get(task.id)
      const lastSession = previousSession.get(task.id)

      tasks.set(task.id, task)

      let state = stateOf(task.id)

      const isReenabled = task.enabled && wasEnabled === false
      const isFresh = isNew && state.anchorAt === null

      if (isReenabled || isFresh) {
        // FR-4 第 6 条 / FR-5 第 8 条：启用即重算基准并清零计数
        state = onTaskEnabled(state, now)
      } else if (state.anchorAt === null) {
        state = { ...state, anchorAt: now }
      }

      // 换了目标会话 → 之前那个会话的 ERROR 不再成立
      if (lastSession !== undefined && lastSession !== task.session) {
        state = clearError(state)
      }

      // 加载期就成立的语义问题（`once` 已过期）→ 以 ERROR 状态存在（D-8 ①）
      if (task.initialError !== null) {
        state = markError(state, task.initialError)
      }

      save(task.id, state)
      previousEnabled.set(task.id, task.enabled)
      previousSession.set(task.id, task.session)
    }

    scheduler.reschedule()
  }

  function noteUserActivity(sessionId: string, at: number): void {
    let changed = false
    for (const task of tasks.values()) {
      if (task.session !== sessionId) continue
      save(task.id, onUserReply(stateOf(task.id), at))
      changed = true
    }
    if (changed) scheduler.reschedule()
  }

  function noteAgentIdle(sessionId: string, at: number): void {
    let changed = false
    for (const task of tasks.values()) {
      if (task.session !== sessionId) continue
      save(task.id, recordIdle(stateOf(task.id), at))
      changed = true
    }
    if (changed) scheduler.reschedule()
  }

  function snapshot(): readonly TaskSnapshot[] {
    const now = deps.clock.now()
    return [...tasks.values()].map((task) => {
      const state = stateOf(task.id)
      const status = statusOf(factsOf(task), state, config.enabled)
      const busy = status === 'armed' && isAgentBusy(task.session)

      return {
        id: task.id,
        name: task.name,
        status,
        nextFireAt: status === 'armed' ? scheduledNextFire(task.id, now) : null,
        fireCount: state.fireCount,
        noReplyStreak: state.noReplyStreak,
        lastResult: state.lastResult,
        lastFiredAt: state.lastFiredAt,
        suspendReason: state.suspendReason,
        suspendedAt: state.suspendedAt,
        errorReason: state.errorReason,
        supersededBy: busy ? 'agent-busy' : null,
      }
    })
  }

  return {
    applyConfig,
    start: () => scheduler.start(),
    stop: () => scheduler.stop(),
    reschedule: () => scheduler.reschedule(),
    noteUserActivity,
    noteAgentIdle,
    fireNow: (taskId) => scheduler.fireNow(taskId),
    snapshot,
    whenIdle: () => scheduler.whenIdle(),
  }
}
