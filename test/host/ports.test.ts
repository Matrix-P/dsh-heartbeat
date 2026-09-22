import { describe, expect, it } from 'vitest'

import type { OutboundMessage } from '../../src/delivery/deliver.js'
import type { AgentCapabilities, AgentLike, TimerLike } from '../../src/host/ports.js'
import { createClockAdapter, createDeliveryPort, toUserMessage } from '../../src/host/ports.js'

interface FakeAgent extends AgentLike {
  readonly followups: unknown[]
  readonly injections: unknown[]
}

function fakeAgent(
  id: string,
  header: { origin?: 'subagent'; parentSession?: string } = {},
  status: 'idle' | 'running' = 'idle',
): FakeAgent {
  return {
    id,
    status,
    session: { header },
    followups: [],
    injections: [],
  }
}

interface World {
  readonly agents: Map<string, FakeAgent>
  readonly caps: AgentCapabilities
  readonly resolveCalls: string[]
  resolveError: unknown
  readonly followupCalls: Array<{ sessionId: string; message: OutboundMessage }>
}

function createWorld(options: { withResolve?: boolean } = {}): World {
  const agents = new Map<string, FakeAgent>()
  const resolveCalls: string[] = []
  const followupCalls: Array<{ sessionId: string; message: OutboundMessage }> = []

  const world: World = {
    agents,
    resolveCalls,
    resolveError: undefined,
    followupCalls,
    caps: {
      getAgent: (id) => agents.get(id),
      rootAgents: () => [...agents.values()].filter((agent) => agent.session.header.parentSession === undefined),
      isOwnedBy: (sessionId, owner) => agents.get(sessionId)?.session.header.parentSession === owner.id,
      followup: (sessionId, message) => {
        const agent = agents.get(sessionId)
        if (agent === undefined) throw new Error(`不是 live 的 Agent：${sessionId}`)
        agent.followups.push(message)
        followupCalls.push({ sessionId, message })
      },
      inject: (sessionId, message) => {
        const agent = agents.get(sessionId)
        if (agent === undefined) throw new Error(`不是 live 的 Agent：${sessionId}`)
        agent.injections.push(message)
      },
      resolveAgent:
        options.withResolve === false
          ? undefined
          : async (sessionId) => {
              resolveCalls.push(sessionId)
              if (world.resolveError !== undefined) throw world.resolveError
            },
    },
  }

  return world
}

const SAMPLE: OutboundMessage = {
  text: '现在是08:00',
  source: { kind: 'plugin', plugin: 'heartbeat', form: 'notice', summary: '心跳提醒' },
}

describe('createDeliveryPort — DSH 形状映射（FR-4）', () => {
  it('isLive / isRoot / statusOf 直接映射', () => {
    const world = createWorld()
    world.agents.set('s1', fakeAgent('s1', {}, 'running'))
    const port = createDeliveryPort(world.caps)

    expect(port.isLive('s1')).toBe(true)
    expect(port.isLive('nope')).toBe(false)
    expect(port.isRoot('s1')).toBe(true)
    expect(port.statusOf('s1')).toBe('running')
    expect(port.statusOf('nope')).toBeUndefined()
  })

  it('子 Agent 会话：header.origin = subagent → 判定为子会话', () => {
    const world = createWorld()
    world.agents.set('child', fakeAgent('child', { origin: 'subagent' }))
    const port = createDeliveryPort(world.caps)

    expect(port.isSubagentSession('child')).toBe(true)
    expect(port.isRoot('child')).toBe(true) // 它就是自己的 root，但仍必须被拒
  })

  it('子 Agent 会话：parentSession 指向 live 的父且 isOwnedBy 为真 → 判定为子会话', () => {
    const world = createWorld()
    world.agents.set('parent', fakeAgent('parent'))
    world.agents.set('child', fakeAgent('child', { parentSession: 'parent' }))
    const port = createDeliveryPort(world.caps)

    expect(port.isSubagentSession('child')).toBe(true)
  })

  it('普通 fork 会话（有 parentSession 但父不拥有它）不算子 Agent 会话', () => {
    const world = createWorld()
    world.agents.set('fork', fakeAgent('fork', { parentSession: 'gone' }))
    const port = createDeliveryPort(world.caps)

    expect(port.isSubagentSession('fork')).toBe(false)
  })

  it('冷会话（不在 live 表里）不会被误判成子会话', () => {
    const world = createWorld()
    const port = createDeliveryPort(world.caps)
    // 冷会话的归属由 host 层 resolveAgent 的 session/agent-busy 负责拒绝
    expect(port.isSubagentSession('cold')).toBe(false)
    expect(port.isLive('cold')).toBe(false)
  })
})

describe('createDeliveryPort — 投递原语', () => {
  it('followup / inject 把消息交给对应 Agent', () => {
    const world = createWorld()
    world.agents.set('s1', fakeAgent('s1'))
    const port = createDeliveryPort(world.caps)

    port.followup('s1', SAMPLE)
    port.inject('s1', SAMPLE)

    expect(world.agents.get('s1')?.followups).toHaveLength(1)
    expect(world.agents.get('s1')?.injections).toHaveLength(1)
  })

  it('对非 live 会话投递会抛错（不静默失败，FR-4 第 4 条）', () => {
    const world = createWorld()
    const port = createDeliveryPort(world.caps)
    expect(() => port.followup('cold', SAMPLE)).toThrow()
  })

  it('提供 resolveAgent 时才挂上 warmUp（否则编排器会走 skipped 而不是误判 ERROR）', () => {
    const withResolve = createDeliveryPort(createWorld().caps)
    const without = createDeliveryPort(createWorld({ withResolve: false }).caps)

    expect(typeof withResolve.warmUp).toBe('function')
    expect(without.warmUp).toBeUndefined()
  })

  it('warmUp 转发到注入的 resolveAgent', async () => {
    const world = createWorld()
    const port = createDeliveryPort(world.caps)

    await port.warmUp?.('s1')

    expect(world.resolveCalls).toEqual(['s1'])
  })
})

describe('toUserMessage — 必须走官方工厂', () => {
  it('产出带 id / role 的官方 UserMessage，并保留 form: notice', () => {
    const message = toUserMessage(SAMPLE)

    expect(message.role).toBe('user')
    expect(typeof message.id).toBe('string')
    expect(message.content).toEqual([{ type: 'text', text: '现在是08:00' }])
    expect(message.source).toMatchObject({ kind: 'plugin', plugin: 'heartbeat', form: 'notice' })
  })

  it('文案原样透传（组件不加工，D-1）', () => {
    const message = toUserMessage({ ...SAMPLE, text: '带{未求值}和 emoji 🍼 的文案' })
    expect(message.content).toEqual([{ type: 'text', text: '带{未求值}和 emoji 🍼 的文案' }])
  })
})

describe('createClockAdapter — 接到 host 的定时器服务上', () => {
  interface FakeTimer extends TimerLike {
    fire(): void
    setTime(value: number): void
    readonly delays: number[]
    readonly cancelled: number
  }

  function fakeTimer(start = 1_000): FakeTimer {
    let time = start
    const pending: Array<{ callback: () => void; id: number }> = []
    const delays: number[] = []
    let cancelledCount = 0
    let nextId = 1

    return {
      now: () => time,
      timeout(callback, delay) {
        const id = nextId
        nextId += 1
        delays.push(delay)
        pending.push({ callback, id })
        return () => {
          cancelledCount += 1
          const index = pending.findIndex((item) => item.id === id)
          if (index >= 0) pending.splice(index, 1)
        }
      },
      fire() {
        const next = pending.shift()
        next?.callback()
      },
      setTime(value) {
        time = value
      },
      delays,
      get cancelled() {
        return cancelledCount
      },
    }
  }

  it('now 透传给注入的时间源', () => {
    const clock = createClockAdapter(fakeTimer(5_000))
    expect(clock.now()).toBe(5_000)
  })

  it('schedule 把延时交给注入的定时器', () => {
    const timer = fakeTimer(1_000)
    const clock = createClockAdapter(timer)

    clock.schedule(4_000, () => undefined)

    expect(timer.delays).toEqual([3_000])
  })

  it('超过 32 位上限的延时会分段（否则 setTimeout 会立刻触发）', () => {
    const timer = fakeTimer(0)
    const clock = createClockAdapter(timer)

    clock.schedule(2_147_483_647 + 10_000, () => undefined)

    expect(timer.delays).toEqual([2_147_483_647])
  })

  it('被提前唤醒时重新 arm，不会漏触发', () => {
    const timer = fakeTimer(0)
    const clock = createClockAdapter(timer)
    let fired = 0
    clock.schedule(1_000, () => {
      fired += 1
    })

    timer.fire() // 时间还没到
    expect(fired).toBe(0)
    expect(timer.delays).toHaveLength(2)

    timer.setTime(1_000)
    timer.fire()
    expect(fired).toBe(1)
  })

  it('取消后即使定时器被触发也不回调', () => {
    const timer = fakeTimer(0)
    const clock = createClockAdapter(timer)
    let fired = 0
    const cancel = clock.schedule(100, () => {
      fired += 1
    })

    cancel()
    timer.fire()

    expect(fired).toBe(0)
    expect(timer.cancelled).toBe(1)
  })
})
