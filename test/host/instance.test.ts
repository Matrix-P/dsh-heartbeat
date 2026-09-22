import { describe, expect, it } from 'vitest'

import type { InstanceInfo } from '../../src/runtime/store.js'
import type { KillLike } from '../../src/host/instance.js'
import {
  createInstanceLockPort,
  parseInstanceInfo,
  probePid,
  serializeInstanceInfo,
} from '../../src/host/instance.js'

function killThrowing(code: string | undefined): KillLike {
  return () => {
    const error = new Error(`模拟 ${code ?? '未知'} 错误`) as Error & { code?: string }
    if (code !== undefined) error.code = code
    throw error
  }
}

const OK_KILL: KillLike = () => undefined

describe('probePid — 进程存活探测（Windows 语义不一致，必须容错）', () => {
  it('就是自己 → alive（不需要真去探测）', () => {
    let called = false
    const kill: KillLike = () => {
      called = true
    }
    expect(probePid(4_242, { selfPid: 4_242, kill })).toBe('alive')
    expect(called).toBe(false)
  })

  it('探测成功 → alive', () => {
    expect(probePid(4_242, { selfPid: 1, kill: OK_KILL })).toBe('alive')
  })

  it('ESRCH（无此进程）→ dead', () => {
    expect(probePid(4_242, { selfPid: 1, kill: killThrowing('ESRCH') })).toBe('dead')
  })

  it('EPERM（进程存在但无权限发信号，Windows 上很常见）→ alive', () => {
    expect(probePid(4_242, { selfPid: 1, kill: killThrowing('EPERM') })).toBe('alive')
  })

  it('其它错误 → unknown（由调用方降级为 warn，绝不误杀）', () => {
    expect(probePid(4_242, { selfPid: 1, kill: killThrowing('EINVAL') })).toBe('unknown')
    expect(probePid(4_242, { selfPid: 1, kill: killThrowing(undefined) })).toBe('unknown')
  })

  it('用自己的进程做真实探测（冒烟）', () => {
    expect(probePid(process.pid)).toBe('alive')
  })
})

describe('serializeInstanceInfo / parseInstanceInfo', () => {
  const INFO: InstanceInfo = { pid: 4_242, startedAt: 1_789_000_000_000, host: 'host-a' }

  it('往返一致', () => {
    expect(parseInstanceInfo(serializeInstanceInfo(INFO))).toEqual(INFO)
  })

  it('非对象 / 缺字段 / 类型错一律判为无效（首次启动时读不到是正常的）', () => {
    expect(parseInstanceInfo(undefined)).toBeUndefined()
    expect(parseInstanceInfo(null)).toBeUndefined()
    expect(parseInstanceInfo('nope')).toBeUndefined()
    expect(parseInstanceInfo({})).toBeUndefined()
    expect(parseInstanceInfo({ pid: 'x', startedAt: 1, host: 'h' })).toBeUndefined()
    expect(parseInstanceInfo({ pid: 1, startedAt: 'x', host: 'h' })).toBeUndefined()
    expect(parseInstanceInfo({ pid: 1, startedAt: 1 })).toBeUndefined()
  })
})

describe('createInstanceLockPort', () => {
  function createPort(initial?: InstanceInfo) {
    let stored = initial
    const port = createInstanceLockPort({
      read: () => stored,
      write: (info) => {
        stored = info
      },
      probe: () => 'alive',
      selfPid: 1,
    })
    return { port, stored: () => stored }
  }

  it('write 之后 read 能读回', () => {
    const { port, stored } = createPort()
    const info: InstanceInfo = { pid: 8, startedAt: 5, host: 'h' }

    port.write(info)

    expect(port.read()).toEqual(info)
    expect(stored()).toEqual(info)
  })

  it('probe 转发到底层探测', () => {
    const calls: number[] = []
    const port = createInstanceLockPort({
      read: () => undefined,
      write: () => undefined,
      probe: (pid) => {
        calls.push(pid)
        return 'dead'
      },
      selfPid: 1,
    })

    expect(port.probe(7)).toBe('dead')
    expect(calls).toEqual([7])
  })

  it('未提供 probe 时使用真实探测（自己的 pid → alive）', () => {
    const port = createInstanceLockPort({ read: () => undefined, write: () => undefined })
    expect(port.probe(process.pid)).toBe('alive')
  })
})
