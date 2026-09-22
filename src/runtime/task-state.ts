/**
 * 任务运行期状态与状态机（需求第 6 章 + FR-5）。
 *
 * 设计要点：
 * - **状态是派生的**：不存单一 `status` 字段，避免「状态与事实不一致」。
 *   优先级严格照需求第 6 章：`DISABLED > ERROR > SUSPENDED > COMPLETED > ARMED`。
 * - 全部函数都是**纯函数**（返回新状态，不改原对象），时刻由调用方传入。
 * - 达上限瞬间的语义按需求 11.1 固化：**第 max 次仍然投递**，
 *   第 max+1 次求值才不投递（对应 FR-5 验收标准「连续 3 次无回复后第 4 次不再触发」）。
 */

/** 需求第 6 章的五种状态。 */
export type TaskStatus = 'disabled' | 'error' | 'suspended' | 'completed' | 'armed'

/** 一次触发/投递的结果，写入 `lastResult` 供界面与日志使用（FR-6 第 3 条）。 */
export type FireResult = 'queued' | 'skipped' | 'failed' | 'manual'

/** 判定与静默需要知道的配置事实（与 schemastery 配置解耦，便于测试）。 */
export interface TaskConfigFacts {
  readonly enabled: boolean
  /** 连续无回应上限；`0` = 关闭该功能（FR-5 第 1 条） */
  readonly noReplyMax: number
  /** 策略 B 的固定判定窗口；`null` = 策略 A（FR-5 第 3 条 / D-4） */
  readonly noReplyWindowMs: number | null
}

/** 运行期状态（技术设计 4.1 节的 zod schema 与此一一对应）。 */
export interface TaskState {
  readonly fireCount: number
  readonly lastFiredAt: number | null
  readonly lastResult: FireResult | null
  readonly noReplyStreak: number
  readonly suspended: boolean
  readonly suspendReason: string | null
  readonly suspendedAt: number | null
  /** once 任务触发完成的时间；非 null 即 COMPLETED */
  readonly completedAt: number | null
  readonly lastUserMsgAt: number | null
  readonly lastIdleAt: number | null
  /** 任务被启用（或从静默恢复）的时刻，计时的基准 */
  readonly anchorAt: number | null
  readonly errorReason: string | null
}

export interface ReplyCheckInput {
  readonly lastUserMsgAt: number | null
  readonly lastFiredAt: number | null
  /** 策略 B 的窗口；`null` = 策略 A（自上次触发以来） */
  readonly windowMs: number | null
}

export interface FireEvaluation {
  /** 更新后的状态（可能已转静默） */
  readonly state: TaskState
  /** 本次是否应当投递 */
  readonly deliver: boolean
  /** 不投递的原因（写入日志与状态查询） */
  readonly suppressReason: string | null
  /** 本次求值对 streak 做了什么，便于日志与测试断言 */
  readonly streakChange: 'reset' | 'incremented' | 'unchanged'
}

export interface DeliveryRecordOptions {
  /**
   * 是否算作一次真实触发（更新 `lastFiredAt` 与 `fireCount`）。
   *
   * - 正常入队 / `onBusy=skip` → `true`（FR-4 第 3 条明确要求 skip 计入）
   * - 投递失败 → `false`：否则会把「没送到」当成「用户没回」，误触发静默
   * - 手动 fire → `false`：需求第 7 章要求不影响 `nextFireAt`
   */
  readonly countsAsFire?: boolean
}

export function initialTaskState(anchorAt: number | null): TaskState {
  return {
    fireCount: 0,
    lastFiredAt: null,
    lastResult: null,
    noReplyStreak: 0,
    suspended: false,
    suspendReason: null,
    suspendedAt: null,
    completedAt: null,
    lastUserMsgAt: null,
    lastIdleAt: null,
    anchorAt,
    errorReason: null,
  }
}

/**
 * 派生任务状态。判断顺序**严格**对应需求第 6 章的优先级，不得调换。
 */
export function statusOf(
  config: TaskConfigFacts,
  state: TaskState,
  globalEnabled: boolean,
): TaskStatus {
  if (!globalEnabled || !config.enabled) return 'disabled'
  if (state.errorReason !== null) return 'error'
  if (state.suspended) return 'suspended'
  if (state.completedAt !== null) return 'completed'
  return 'armed'
}

/**
 * 判断「上一次触发是否得到了用户回应」（FR-5 第 2/3 条）。
 *
 * 策略 A（`windowMs === null`）：自上次触发以来有用户消息即可。
 * 策略 B：用户消息必须落在触发后 `windowMs` 之内（含端点）。
 */
export function hasReplied(input: ReplyCheckInput): boolean {
  const { lastUserMsgAt, lastFiredAt, windowMs } = input
  if (lastUserMsgAt === null || lastFiredAt === null) return false
  if (lastUserMsgAt <= lastFiredAt) return false
  if (windowMs !== null && lastUserMsgAt > lastFiredAt + windowMs) return false
  return true
}

/**
 * 触发求值：更新 streak，并决定本次是否投递。
 *
 * 语义（需求 11.1）：`max` 次「无回应」累计完成之后，**下一次**求值才停。
 * 因此 `max = 3` 时第 1–3 次都真实投递，第 4 次求值不再投递。
 */
export function evaluateFire(
  config: TaskConfigFacts,
  state: TaskState,
  globalEnabled: boolean,
  now: number,
): FireEvaluation {
  const status = statusOf(config, state, globalEnabled)

  switch (status) {
    case 'disabled':
      return { state, deliver: false, suppressReason: '任务或组件已停用', streakChange: 'unchanged' }
    case 'error':
      return { state, deliver: false, suppressReason: state.errorReason, streakChange: 'unchanged' }
    case 'suspended':
      return {
        state,
        deliver: false,
        suppressReason: state.suspendReason ?? '已静默',
        streakChange: 'unchanged',
      }
    case 'completed':
      return { state, deliver: false, suppressReason: 'once 任务已完成', streakChange: 'unchanged' }
    case 'armed':
      break
  }

  // 功能关闭：永不自动静默，计数也一并归零（界面不必展示无意义的数字）
  if (config.noReplyMax <= 0) {
    return {
      state: { ...state, noReplyStreak: 0 },
      deliver: true,
      suppressReason: null,
      streakChange: 'reset',
    }
  }

  let streak = state.noReplyStreak
  let streakChange: FireEvaluation['streakChange'] = 'unchanged'

  if (state.lastFiredAt === null) {
    // 从未触发过：没有「上次」可判定，不累加
    streak = 0
  } else if (
    hasReplied({
      lastUserMsgAt: state.lastUserMsgAt,
      lastFiredAt: state.lastFiredAt,
      windowMs: config.noReplyWindowMs,
    })
  ) {
    streak = 0
    streakChange = 'reset'
  } else {
    streak = state.noReplyStreak + 1
    streakChange = 'incremented'
  }

  if (streak >= config.noReplyMax) {
    const reason = `连续 ${streak} 次无回应，已自动静默`
    return {
      state: { ...state, noReplyStreak: streak, suspended: true, suspendReason: reason, suspendedAt: now },
      deliver: false,
      suppressReason: reason,
      streakChange,
    }
  }

  return { state: { ...state, noReplyStreak: streak }, deliver: true, suppressReason: null, streakChange }
}

/** 记录一次投递结果。 */
export function recordDelivery(
  state: TaskState,
  at: number,
  result: FireResult,
  options: DeliveryRecordOptions = {},
): TaskState {
  const countsAsFire = options.countsAsFire ?? true
  if (!countsAsFire) return { ...state, lastResult: result }

  return { ...state, lastFiredAt: at, lastResult: result, fireCount: state.fireCount + 1 }
}

/**
 * 用户发言（FR-5 第 5 条）：立即清零、解除静默，**以该时刻为计时基准重算**，
 * 且**不在恢复瞬间补发一次**。
 */
export function onUserReply(state: TaskState, at: number): TaskState {
  return {
    ...state,
    lastUserMsgAt: at,
    noReplyStreak: 0,
    suspended: false,
    suspendReason: null,
    suspendedAt: null,
    anchorAt: at,
  }
}

/**
 * 任务被启用（含「停用后再启用」与手动清除静默）：
 * FR-5 第 8 条要求清空无回应计数，并以启用时刻为新基准。
 */
export function onTaskEnabled(state: TaskState, at: number): TaskState {
  return {
    ...state,
    noReplyStreak: 0,
    suspended: false,
    suspendReason: null,
    suspendedAt: null,
    errorReason: null,
    anchorAt: at,
  }
}

/** 标记不可恢复错误（FR-4 第 4 条：会话不存在等）。 */
export function markError(state: TaskState, reason: string): TaskState {
  return { ...state, errorReason: reason }
}

export function clearError(state: TaskState): TaskState {
  return state.errorReason === null ? state : { ...state, errorReason: null }
}

/** once 任务触发完成（FR-1 第 4 条：记录完成时间，重启后不再触发）。 */
export function completeOnce(state: TaskState, at: number): TaskState {
  return { ...state, completedAt: at }
}

/** 记录「模型说完」的时刻（FR-8）。 */
export function recordIdle(state: TaskState, at: number): TaskState {
  return { ...state, lastIdleAt: at }
}
