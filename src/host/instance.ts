/**
 * 单实例防御的 host 侧实现（D-10 / 技术设计 4.3）。
 *
 * **为什么要容错**：`process.kill(pid, 0)` 在 Windows 上的语义与 POSIX 不一致 ——
 * 对已存在但无权限的进程会抛 `EPERM` 而不是成功或 `ESRCH`。因此探测结果建模为
 * **三态** `alive | dead | unknown`，`unknown` 交给 `checkSingleInstance` 降级为
 * warn，**绝不因为探测不确定就把用户锁在门外**。
 */

import type { InstanceInfo, InstanceLockPort } from '../runtime/store.js'

export type Liveness = 'alive' | 'dead' | 'unknown'

export type KillLike = (pid: number, signal: number) => void

export interface ProbeOptions {
  readonly selfPid?: number
  readonly kill?: KillLike
}

/** 探测某进程是否存活。 */
export function probePid(pid: number, options: ProbeOptions = {}): Liveness {
  const selfPid = options.selfPid ?? process.pid
  if (pid === selfPid) return 'alive'

  const kill = options.kill ?? process.kill
  try {
    kill(pid, 0)
    return 'alive'
  } catch (error) {
    const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined
    if (code === 'ESRCH') return 'dead'
    // EPERM = 进程存在但发不了信号（Windows 上常见）→ 按存活处理
    if (code === 'EPERM') return 'alive'
    return 'unknown'
  }
}

export function serializeInstanceInfo(info: InstanceInfo): Record<string, unknown> {
  return { pid: info.pid, startedAt: info.startedAt, host: info.host }
}

/** 解析实例记录；格式不对（含首次启动时读不到）一律返回 `undefined`。 */
export function parseInstanceInfo(raw: unknown): InstanceInfo | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined

  const record = raw as Record<string, unknown>
  const { pid, startedAt, host } = record

  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return undefined
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) return undefined
  if (typeof host !== 'string') return undefined

  return { pid, startedAt, host }
}

export interface InstanceLockPortOptions {
  read(): InstanceInfo | undefined
  write(info: InstanceInfo): void
  /** 覆盖探测实现（测试用）；缺省走 {@link probePid} */
  probe?(pid: number): Liveness
  selfPid?: number
}

export function createInstanceLockPort(options: InstanceLockPortOptions): InstanceLockPort {
  return {
    read: () => options.read(),
    write: (info) => options.write(info),
    probe: (pid) => (options.probe ?? ((target: number) => probePid(target, { selfPid: options.selfPid })))(pid),
  }
}
