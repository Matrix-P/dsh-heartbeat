import { describe, expect, it } from 'vitest'

import type { InstanceInfo, InstanceLockPort } from '../../src/runtime/store.js'
import {
  checkSingleInstance,
  createMemoryTaskStore,
  parseTaskState,
  serializeTaskState,
} from '../../src/runtime/store.js'
import type { TaskState } from '../../src/runtime/task-state.js'

const FULL_STATE: TaskState = {
  fireCount: 12,
  lastFiredAt: 1_789_000_000_000,
  lastResult: 'queued',
  noReplyStreak: 2,
  suspended: true,
  suspendReason: '连续 2 次无回应，已自动静默',
  suspendedAt: 1_789_000_001_000,
  completedAt: null,
  lastUserMsgAt: 1_788_999_000_000,
  lastIdleAt: 1_788_998_000_000,
  anchorAt: 1_788_000_000_000,
  errorReason: null,
}

describe('serializeTaskState / parseTaskState', () => {
  it('往返一致（T24：lastIdleAt 必须能落盘再读回）', () => {
    expect(parseTaskState(serializeTaskState(FULL_STATE))).toEqual(FULL_STATE)
  })

  it('null 字段也被显式写出，避免「缺字段」与「值为空」混淆', () => {
    const serialized = serializeTaskState(FULL_STATE)
    expect(serialized).toHaveProperty('completedAt', null)
    expect(serialized).toHaveProperty('errorReason', null)
    expect(serialized).toHaveProperty('lastIdleAt')
  })

  it('可选字段缺失时取默认值（向前兼容旧版本记录）', () => {
    expect(parseTaskState({})).toEqual({
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
      anchorAt: null,
      errorReason: null,
    })
  })

  it('忽略未知的多余字段（向前兼容新版本记录）', () => {
    const parsed = parseTaskState({ ...serializeTaskState(FULL_STATE), futureField: 1 })
    expect(parsed).toEqual(FULL_STATE)
  })
})

describe('parseTaskState — 坏记录识别（invalidRecords: backup-and-skip）', () => {
  it('非对象一律判为坏记录', () => {
    expect(parseTaskState(null)).toBeUndefined()
    expect(parseTaskState('nope')).toBeUndefined()
    expect(parseTaskState(42)).toBeUndefined()
    expect(parseTaskState([])).toBeUndefined()
  })

  it('数值字段类型错 → 坏记录', () => {
    expect(parseTaskState({ fireCount: '12' })).toBeUndefined()
    expect(parseTaskState({ noReplyStreak: -1 })).toBeUndefined()
    expect(parseTaskState({ lastFiredAt: 'yesterday' })).toBeUndefined()
    expect(parseTaskState({ anchorAt: Number.NaN })).toBeUndefined()
  })

  it('布尔 / 字符串 / 枚举字段类型错 → 坏记录', () => {
    expect(parseTaskState({ suspended: 'yes' })).toBeUndefined()
    expect(parseTaskState({ suspendReason: 5 })).toBeUndefined()
    expect(parseTaskState({ lastResult: 'exploded' })).toBeUndefined()
  })

  it('可空字段允许显式 null', () => {
    expect(parseTaskState({ lastResult: null, suspendReason: null })?.lastResult).toBeNull()
  })
})

describe('createMemoryTaskStore', () => {
  it('实现 TaskStorePort 的读写删', () => {
    const store = createMemoryTaskStore()
    expect(store.load('a')).toBeUndefined()

    store.save('a', FULL_STATE)
    expect(store.load('a')).toEqual(FULL_STATE)

    store.remove('a')
    expect(store.load('a')).toBeUndefined()
  })

  it('支持从初始快照启动（模拟进程重启）', () => {
    const store = createMemoryTaskStore({ a: FULL_STATE })
    expect(store.load('a')).toEqual(FULL_STATE)
  })
})

// ── 单实例防御（D-10） ─────────────────────────────────────────────────────

function lockPort(
  stored: InstanceInfo | undefined,
  probeResult: 'alive' | 'dead' | 'unknown' = 'alive',
): InstanceLockPort {
  return {
    read: () => stored,
    write: () => undefined,
    probe: () => probeResult,
  }
}

const ME: InstanceInfo = { pid: 4_242, startedAt: 1_000, host: 'host-a' }

describe('checkSingleInstance — 默认 warn（不把用户锁死）', () => {
  it('没有历史记录 → ok', () => {
    expect(checkSingleInstance('warn', ME, lockPort(undefined))).toEqual({ kind: 'ok' })
  })

  it('记录的就是自己（pid 相同）→ ok', () => {
    expect(checkSingleInstance('warn', ME, lockPort({ ...ME, startedAt: 500 }))).toEqual({
      kind: 'ok',
    })
  })

  it('另一个存活实例 → warn（照常运行但提示）', () => {
    const other: InstanceInfo = { pid: 9_999, startedAt: 900, host: 'host-b' }
    const verdict = checkSingleInstance('warn', ME, lockPort(other, 'alive'))
    expect(verdict.kind).toBe('warn')
    if (verdict.kind === 'warn') expect(verdict.other).toEqual(other)
  })

  it('另一个实例已死 → ok', () => {
    const other: InstanceInfo = { pid: 9_999, startedAt: 900, host: 'host-b' }
    expect(checkSingleInstance('warn', ME, lockPort(other, 'dead'))).toEqual({ kind: 'ok' })
  })

  it('mode=off 时完全不检查', () => {
    const other: InstanceInfo = { pid: 9_999, startedAt: 900, host: 'host-b' }
    expect(checkSingleInstance('off', ME, lockPort(other, 'alive'))).toEqual({ kind: 'ok' })
  })
})

describe('checkSingleInstance — mode=block', () => {
  it('另一个存活实例 → blocked', () => {
    const other: InstanceInfo = { pid: 9_999, startedAt: 900, host: 'host-b' }
    expect(checkSingleInstance('block', ME, lockPort(other, 'alive')).kind).toBe('blocked')
  })

  it('探测结果不确定（Windows 上 pid 探测语义不一致）→ 降级为 warn，绝不错杀', () => {
    const other: InstanceInfo = { pid: 9_999, startedAt: 900, host: 'host-b' }
    expect(checkSingleInstance('block', ME, lockPort(other, 'unknown')).kind).toBe('warn')
  })

  it('提示信息里带上对方 pid 与启动时间，便于用户排查', () => {
    const other: InstanceInfo = { pid: 9_999, startedAt: 900, host: 'host-b' }
    const verdict = checkSingleInstance('block', ME, lockPort(other, 'alive'))
    if (verdict.kind !== 'blocked') throw new Error('应为 blocked')
    expect(verdict.message).toContain('9999')
  })
})
