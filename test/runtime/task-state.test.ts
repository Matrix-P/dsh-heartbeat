import { describe, expect, it } from 'vitest'

import type { TaskConfigFacts, TaskState } from '../../src/runtime/task-state.js'
import {
  evaluateFire,
  hasReplied,
  initialTaskState,
  markError,
  onTaskEnabled,
  onUserReply,
  recordDelivery,
  statusOf,
} from '../../src/runtime/task-state.js'

const MIN = 60_000

function config(overrides: Partial<TaskConfigFacts> = {}): TaskConfigFacts {
  return { enabled: true, noReplyMax: 3, noReplyWindowMs: null, ...overrides }
}

describe('statusOf — 需求第 6 章的状态优先级', () => {
  const armed = initialTaskState(1_000)

  it('组件全局关闭 → disabled', () => {
    expect(statusOf(config(), armed, false)).toBe('disabled')
  })

  it('任务自身停用 → disabled', () => {
    expect(statusOf(config({ enabled: false }), armed, true)).toBe('disabled')
  })

  it('global 优先于一切', () => {
    const state: TaskState = { ...armed, errorReason: 'boom', suspended: true, completedAt: 1 }
    expect(statusOf(config(), state, false)).toBe('disabled')
  })

  it('ERROR 优先于 SUSPENDED / COMPLETED', () => {
    const state: TaskState = { ...armed, errorReason: 'session-not-found', suspended: true, completedAt: 1 }
    expect(statusOf(config(), state, true)).toBe('error')
  })

  it('SUSPENDED 优先于 COMPLETED', () => {
    const state: TaskState = { ...armed, suspended: true, completedAt: 1 }
    expect(statusOf(config(), state, true)).toBe('suspended')
  })

  it('COMPLETED 优先于 ARMED', () => {
    expect(statusOf(config(), { ...armed, completedAt: 1 }, true)).toBe('completed')
  })

  it('无特殊标记 → armed', () => {
    expect(statusOf(config(), armed, true)).toBe('armed')
  })
})

describe('hasReplied — 回应判定（FR-5 第 2/3 条，D-4）', () => {
  const firedAt = 1_000_000

  it('从未发言 → false', () => {
    expect(hasReplied({ lastUserMsgAt: null, lastFiredAt: firedAt, windowMs: null })).toBe(false)
  })

  it('从未触发过 → false（没有「上次触发」可判定）', () => {
    expect(hasReplied({ lastUserMsgAt: firedAt + MIN, lastFiredAt: null, windowMs: null })).toBe(false)
  })

  it('策略 A：触发之后有用户消息 → true', () => {
    expect(hasReplied({ lastUserMsgAt: firedAt + MIN, lastFiredAt: firedAt, windowMs: null })).toBe(true)
  })

  it('策略 A：用户消息在触发之前 → false', () => {
    expect(hasReplied({ lastUserMsgAt: firedAt - MIN, lastFiredAt: firedAt, windowMs: null })).toBe(false)
  })

  it('策略 A：同一时刻（= 触发瞬间）不计为回应', () => {
    expect(hasReplied({ lastUserMsgAt: firedAt, lastFiredAt: firedAt, windowMs: null })).toBe(false)
  })

  it('策略 B：落在窗口内（含端点）→ true', () => {
    const windowMs = 10 * MIN
    expect(hasReplied({ lastUserMsgAt: firedAt + windowMs, lastFiredAt: firedAt, windowMs })).toBe(true)
  })

  it('策略 B：超出窗口 → false', () => {
    const windowMs = 10 * MIN
    expect(hasReplied({ lastUserMsgAt: firedAt + windowMs + 1, lastFiredAt: firedAt, windowMs })).toBe(false)
  })
})

describe('evaluateFire — 计数与静默', () => {
  it('首次触发（无 lastFiredAt）不累加 streak，且照常投递', () => {
    const result = evaluateFire(config(), initialTaskState(1_000), true, 1_000)
    expect(result.deliver).toBe(true)
    expect(result.streakChange).toBe('unchanged')
    expect(result.state.noReplyStreak).toBe(0)
  })

  it('期间有用户回复 → streak 归零并投递', () => {
    const state: TaskState = { ...initialTaskState(0), lastFiredAt: 1_000, noReplyStreak: 2, lastUserMsgAt: 1_500 }
    const result = evaluateFire(config(), state, true, 2_000)
    expect(result.deliver).toBe(true)
    expect(result.streakChange).toBe('reset')
    expect(result.state.noReplyStreak).toBe(0)
  })

  it('无回应 → streak 累加，未达上限仍投递', () => {
    const state: TaskState = { ...initialTaskState(0), lastFiredAt: 1_000, noReplyStreak: 1 }
    const result = evaluateFire(config(), state, true, 2_000)
    expect(result.deliver).toBe(true)
    expect(result.streakChange).toBe('incremented')
    expect(result.state.noReplyStreak).toBe(2)
  })

  it('达到上限 → 本次不投递并转静默，记录原因与时间', () => {
    const state: TaskState = { ...initialTaskState(0), lastFiredAt: 1_000, noReplyStreak: 2 }
    const result = evaluateFire(config(), state, true, 2_000)
    expect(result.deliver).toBe(false)
    expect(result.state.noReplyStreak).toBe(3)
    expect(result.state.suspended).toBe(true)
    expect(result.state.suspendedAt).toBe(2_000)
    expect(result.state.suspendReason).toBeTruthy()
    expect(statusOf(config(), result.state, true)).toBe('suspended')
  })

  it('已静默 → 一律不投递，且不再累加 streak', () => {
    const state: TaskState = {
      ...initialTaskState(0),
      lastFiredAt: 1_000,
      noReplyStreak: 3,
      suspended: true,
      suspendReason: 'no-reply:3',
      suspendedAt: 2_000,
    }
    const result = evaluateFire(config(), state, true, 3_000)
    expect(result.deliver).toBe(false)
    expect(result.state.noReplyStreak).toBe(3)
  })

  it('completed / error / disabled 状态一律不投递', () => {
    const base = initialTaskState(0)
    expect(evaluateFire(config(), { ...base, completedAt: 1 }, true, 100).deliver).toBe(false)
    expect(evaluateFire(config(), markError(base, 'session-not-found'), true, 100).deliver).toBe(false)
    expect(evaluateFire(config({ enabled: false }), base, true, 100).deliver).toBe(false)
    expect(evaluateFire(config(), base, false, 100).deliver).toBe(false)
  })

  it('T12：noReply.max = 0 表示关闭该功能，永不自动静默', () => {
    const cfg = config({ noReplyMax: 0 })
    let state: TaskState = recordDelivery(initialTaskState(0), 1_000, 'queued')

    for (let round = 0; round < 50; round += 1) {
      const evaluation = evaluateFire(cfg, state, true, 2_000 + round * MIN)
      expect(evaluation.deliver).toBe(true)
      state = recordDelivery(evaluation.state, 3_000 + round * MIN, 'queued')
    }

    expect(state.noReplyStreak).toBe(0)
    expect(statusOf(cfg, state, true)).toBe('armed')
  })
})

describe('T1 — 完整序列：noReply.max = 3 时第 4 次不再投递', () => {
  it('第 1–3 次投递，第 4 次不投递并静默', () => {
    const cfg = config({ noReplyMax: 3 })
    let state = initialTaskState(0)
    const decisions: boolean[] = []
    let at = 1_000_000

    for (let round = 0; round < 4; round += 1) {
      const evaluation = evaluateFire(cfg, state, true, at)
      decisions.push(evaluation.deliver)
      state = evaluation.state
      if (evaluation.deliver) state = recordDelivery(state, at, 'queued')
      at += 30 * MIN
    }

    expect(decisions).toEqual([true, true, true, false])
    expect(state.noReplyStreak).toBe(3)
    expect(statusOf(cfg, state, true)).toBe('suspended')
  })

  it('中间插入一次用户回复，计数会重新开始', () => {
    const cfg = config({ noReplyMax: 2 })
    let state = initialTaskState(0)
    const decisions: boolean[] = []
    let at = 1_000_000

    for (let round = 0; round < 5; round += 1) {
      const evaluation = evaluateFire(cfg, state, true, at)
      decisions.push(evaluation.deliver)
      state = evaluation.state
      if (evaluation.deliver) state = recordDelivery(state, at, 'queued')
      // 第 2 轮触发之后用户回了一句：streak 归零，于是后面的计数从头开始
      if (round === 1) state = onUserReply(state, at + 1_000)
      at += 30 * MIN
    }

    // 只有最后一轮（第 5 次求值）因为累计到 2 次无回应才不投递
    expect(decisions).toEqual([true, true, true, true, false])
    expect(state.noReplyStreak).toBe(2)
  })
})

describe('T2 — 恢复：用户回复即清零、解除静默、以回复时刻为基准', () => {
  it('onUserReply 清空计数与静默标记，并写入新的 anchorAt', () => {
    const state: TaskState = {
      ...initialTaskState(0),
      lastFiredAt: 1_000,
      noReplyStreak: 3,
      suspended: true,
      suspendReason: 'no-reply:3',
      suspendedAt: 2_000,
    }

    const recovered = onUserReply(state, 5_000)

    expect(recovered.noReplyStreak).toBe(0)
    expect(recovered.suspended).toBe(false)
    expect(recovered.suspendReason).toBeNull()
    expect(recovered.suspendedAt).toBeNull()
    expect(recovered.lastUserMsgAt).toBe(5_000)
    expect(recovered.anchorAt).toBe(5_000)
    expect(statusOf(config(), recovered, true)).toBe('armed')
  })
})

describe('T11 — 停用再启用清空计数', () => {
  it('onTaskEnabled 清零 streak、清除静默与错误、重置 anchorAt', () => {
    const state: TaskState = {
      ...initialTaskState(0),
      noReplyStreak: 2,
      suspended: true,
      suspendReason: 'no-reply:2',
      suspendedAt: 1,
      errorReason: 'session-not-found',
    }

    const enabled = onTaskEnabled(state, 9_000)

    expect(enabled.noReplyStreak).toBe(0)
    expect(enabled.suspended).toBe(false)
    expect(enabled.errorReason).toBeNull()
    expect(enabled.anchorAt).toBe(9_000)
    expect(statusOf(config(), enabled, true)).toBe('armed')
  })
})

describe('recordDelivery — 计数口径', () => {
  it('正常入队：更新基准、累加次数、记录结果', () => {
    const after = recordDelivery(initialTaskState(0), 1_000, 'queued')
    expect(after.lastFiredAt).toBe(1_000)
    expect(after.fireCount).toBe(1)
    expect(after.lastResult).toBe('queued')
  })

  it('onBusy=skip 属于一次真实触发（FR-4 第 3 条要求计入）', () => {
    const after = recordDelivery(initialTaskState(0), 1_000, 'skipped')
    expect(after.lastFiredAt).toBe(1_000)
    expect(after.fireCount).toBe(1)
  })

  it('投递失败不计入：否则会把「没送到」当成「用户没回」而误静默', () => {
    const after = recordDelivery(initialTaskState(0), 1_000, 'failed', { countsAsFire: false })
    expect(after.lastFiredAt).toBeNull()
    expect(after.fireCount).toBe(0)
    expect(after.lastResult).toBe('failed')
  })

  it('手动 fire 不影响计数与计时基准（需求第 7 章）', () => {
    const after = recordDelivery(initialTaskState(0), 1_000, 'manual', { countsAsFire: false })
    expect(after.lastFiredAt).toBeNull()
    expect(after.fireCount).toBe(0)
    expect(after.lastResult).toBe('manual')
  })
})

describe('initialTaskState / markError', () => {
  it('初始状态干净，anchorAt 为启用时刻', () => {
    const state = initialTaskState(1_234)
    expect(state).toMatchObject({
      fireCount: 0,
      lastFiredAt: null,
      lastResult: null,
      noReplyStreak: 0,
      suspended: false,
      completedAt: null,
      lastUserMsgAt: null,
      lastIdleAt: null,
      anchorAt: 1_234,
      errorReason: null,
    })
  })

  it('markError 写入原因，statusOf 随之变为 error', () => {
    const state = markError(initialTaskState(0), 'session/not-found')
    expect(state.errorReason).toBe('session/not-found')
    expect(statusOf(config(), state, true)).toBe('error')
  })
})
