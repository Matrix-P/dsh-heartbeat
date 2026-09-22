/**
 * 运行期状态的序列化与单实例防御（技术设计 4.1 / 4.3 / D-10）。
 *
 * 两个原则：
 * 1. **坏记录隔离**：读不出合法状态的记录返回 `undefined`，由调用方跳过（对应
 *    `invalidRecords: 'backup-and-skip'`），绝不让一条脏数据把整个组件拖挂。
 * 2. **单实例只做轻量防御**：探测结果不确定时**降级为 warn**，绝不因为探测失败
 *    把用户锁在门外（Windows 上 `process.kill(pid, 0)` 的语义与 POSIX 不一致）。
 *
 * 本模块不依赖 zod / storageDomain：真正的落盘适配由 host 层完成，这里只负责
 * 「对象 ↔ 状态」的双向转换与判定逻辑，因此可以纯单测。
 */

import type { SingleInstance } from '../config.js'
import type { FireResult, TaskState } from './task-state.js'
import type { TaskStorePort } from './orchestrator.js'

const FIRE_RESULTS: readonly FireResult[] = ['queued', 'skipped', 'failed', 'manual']

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 读取结果：`ok: false` 表示「字段存在但类型非法」= 坏记录。 */
type Read<T> = { readonly ok: true; readonly value: T } | { readonly ok: false }

const INVALID: Read<never> = { ok: false }

function readNonNegativeInt(value: unknown, fallback: number): Read<number> {
  if (value === undefined) return { ok: true, value: fallback }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return INVALID
  return { ok: true, value }
}

function readBoolean(value: unknown, fallback: boolean): Read<boolean> {
  if (value === undefined) return { ok: true, value: fallback }
  if (typeof value !== 'boolean') return INVALID
  return { ok: true, value }
}

function readNullableTimestamp(value: unknown): Read<number | null> {
  if (value === undefined || value === null) return { ok: true, value: null }
  if (typeof value !== 'number' || !Number.isFinite(value)) return INVALID
  return { ok: true, value }
}

function readNullableString(value: unknown): Read<string | null> {
  if (value === undefined || value === null) return { ok: true, value: null }
  if (typeof value !== 'string') return INVALID
  return { ok: true, value }
}

function readFireResult(value: unknown): Read<FireResult | null> {
  if (value === undefined || value === null) return { ok: true, value: null }
  if (typeof value !== 'string') return INVALID
  if (!(FIRE_RESULTS as readonly string[]).includes(value)) return INVALID
  return { ok: true, value: value as FireResult }
}

/** 状态 → 可落盘的普通对象。`null` 字段也显式写出，避免「缺字段」与「值为空」混淆。 */
export function serializeTaskState(state: TaskState): Record<string, unknown> {
  return {
    fireCount: state.fireCount,
    lastFiredAt: state.lastFiredAt,
    lastResult: state.lastResult,
    noReplyStreak: state.noReplyStreak,
    suspended: state.suspended,
    suspendReason: state.suspendReason,
    suspendedAt: state.suspendedAt,
    completedAt: state.completedAt,
    lastUserMsgAt: state.lastUserMsgAt,
    lastIdleAt: state.lastIdleAt,
    anchorAt: state.anchorAt,
    errorReason: state.errorReason,
  }
}

/**
 * 普通对象 → 状态。
 *
 * - **缺失**字段取默认值（向前兼容旧版本记录）
 * - **存在但类型非法** → 返回 `undefined`（判为坏记录，由调用方跳过并备份）
 * - **多余**字段忽略（向前兼容新版本记录）
 *
 * @returns 合法状态；记录损坏时 `undefined`
 */
export function parseTaskState(raw: unknown): TaskState | undefined {
  if (!isPlainObject(raw)) return undefined

  const fireCount = readNonNegativeInt(raw.fireCount, 0)
  if (!fireCount.ok) return undefined
  const lastFiredAt = readNullableTimestamp(raw.lastFiredAt)
  if (!lastFiredAt.ok) return undefined
  const lastResult = readFireResult(raw.lastResult)
  if (!lastResult.ok) return undefined
  const noReplyStreak = readNonNegativeInt(raw.noReplyStreak, 0)
  if (!noReplyStreak.ok) return undefined
  const suspended = readBoolean(raw.suspended, false)
  if (!suspended.ok) return undefined
  const suspendReason = readNullableString(raw.suspendReason)
  if (!suspendReason.ok) return undefined
  const suspendedAt = readNullableTimestamp(raw.suspendedAt)
  if (!suspendedAt.ok) return undefined
  const completedAt = readNullableTimestamp(raw.completedAt)
  if (!completedAt.ok) return undefined
  const lastUserMsgAt = readNullableTimestamp(raw.lastUserMsgAt)
  if (!lastUserMsgAt.ok) return undefined
  const lastIdleAt = readNullableTimestamp(raw.lastIdleAt)
  if (!lastIdleAt.ok) return undefined
  const anchorAt = readNullableTimestamp(raw.anchorAt)
  if (!anchorAt.ok) return undefined
  const errorReason = readNullableString(raw.errorReason)
  if (!errorReason.ok) return undefined

  return {
    fireCount: fireCount.value,
    lastFiredAt: lastFiredAt.value,
    lastResult: lastResult.value,
    noReplyStreak: noReplyStreak.value,
    suspended: suspended.value,
    suspendReason: suspendReason.value,
    suspendedAt: suspendedAt.value,
    completedAt: completedAt.value,
    lastUserMsgAt: lastUserMsgAt.value,
    lastIdleAt: lastIdleAt.value,
    anchorAt: anchorAt.value,
    errorReason: errorReason.value,
  }
}

/** 内存实现：测试用，也可作为 storageDomain 不可用时的降级实现。 */
export function createMemoryTaskStore(initial?: Record<string, TaskState>): TaskStorePort {
  const records = new Map<string, TaskState>(Object.entries(initial ?? {}))
  return {
    load: (taskId) => records.get(taskId),
    save: (taskId, state) => {
      records.set(taskId, state)
    },
    remove: (taskId) => {
      records.delete(taskId)
    },
  }
}

// ── 单实例防御（D-10） ─────────────────────────────────────────────────────

export interface InstanceInfo {
  readonly pid: number
  readonly startedAt: number
  readonly host: string
}

export interface InstanceLockPort {
  read(): InstanceInfo | undefined
  write(info: InstanceInfo): void
  /** 探测 pid 是否存活；`unknown` = 无法确定（Windows 上很常见） */
  probe(pid: number): 'alive' | 'dead' | 'unknown'
}

export type SingleInstanceVerdict =
  | { readonly kind: 'ok' }
  | { readonly kind: 'warn'; readonly message: string; readonly other: InstanceInfo }
  | { readonly kind: 'blocked'; readonly message: string; readonly other: InstanceInfo }

/**
 * 判断是否已有另一个实例在跑。
 *
 * | `mode` | 另一个实例**确认存活** | 探测结果**不确定** |
 * | --- | --- | --- |
 * | `off` | ok | ok |
 * | `warn` | warn | warn |
 * | `block` | **blocked** | **warn**（降级，不错杀） |
 */
export function checkSingleInstance(
  mode: SingleInstance,
  self: InstanceInfo,
  port: InstanceLockPort,
): SingleInstanceVerdict {
  if (mode === 'off') return { kind: 'ok' }

  const other = port.read()
  if (other === undefined || other.pid === self.pid) return { kind: 'ok' }

  // 只探测一次：probe 可能有副作用（真的去探进程），重复调用还可能给出不一致结果
  const liveness = port.probe(other.pid)
  if (liveness === 'dead') return { kind: 'ok' }

  const message =
    `检测到另一个疑似存活的 DSH 实例（pid ${other.pid}，启动于 ${other.startedAt}，主机 ${other.host}）：` +
    '两套调度器会重复投递、并互相覆盖运行期状态。'

  if (mode === 'block' && liveness === 'alive') {
    return { kind: 'blocked', message: `${message} 已拒绝启动调度器（singleInstance: block）。`, other }
  }
  return { kind: 'warn', message, other }
}
