import { describe, expect, it } from 'vitest'

import type { DeliveryPort, OutboundMessage } from '../../src/delivery/deliver.js'
import { buildOutboundMessage, classifyWarmUpError, deliver, PLUGIN_SOURCE } from '../../src/delivery/deliver.js'

interface World {
  readonly live: Set<string>
  readonly roots: Set<string>
  readonly subagents: Set<string>
  readonly statuses: Map<string, 'idle' | 'running'>
  warmUpError: unknown
  warmUpCalls: string[]
  followupError: unknown
  readonly followups: Array<{ sessionId: string; message: OutboundMessage }>
  readonly injections: Array<{ sessionId: string; message: OutboundMessage }>
  readonly port: DeliveryPort
}

function createWorld(): World {
  const live = new Set<string>()
  const roots = new Set<string>()
  const subagents = new Set<string>()
  const statuses = new Map<string, 'idle' | 'running'>()
  const followups: Array<{ sessionId: string; message: OutboundMessage }> = []
  const injections: Array<{ sessionId: string; message: OutboundMessage }> = []

  const world: World = {
    live,
    roots,
    subagents,
    statuses,
    warmUpError: undefined,
    warmUpCalls: [],
    followupError: undefined,
    followups,
    injections,
    port: {
      isLive: (id) => live.has(id),
      isRoot: (id) => roots.has(id),
      isSubagentSession: (id) => subagents.has(id),
      statusOf: (id) => statuses.get(id) ?? (live.has(id) ? 'idle' : undefined),
      warmUp: async (id) => {
        world.warmUpCalls.push(id)
        if (world.warmUpError !== undefined) throw world.warmUpError
        live.add(id)
        roots.add(id)
        statuses.set(id, 'idle')
      },
      followup: (sessionId, message) => {
        if (world.followupError !== undefined) throw world.followupError
        followups.push({ sessionId, message })
      },
      inject: (sessionId, message) => {
        injections.push({ sessionId, message })
      },
    },
  }

  return world
}

/** 把一个会话设成正常的根会话（live、idle） */
function makeRoot(world: World, sessionId: string): void {
  world.live.add(sessionId)
  world.roots.add(sessionId)
  world.statuses.set(sessionId, 'idle')
}

const BASE = { text: '现在是{time}', onBusy: 'queue', coldWake: 'session-controller' } as const

describe('buildOutboundMessage — 投递消息的来源标记', () => {
  it('带 form: notice，避免被客户端渲染成「用户自己说的」气泡', () => {
    const message = buildOutboundMessage('早上好')
    expect(message.source.form).toBe('notice')
    expect(message.source.kind).toBe('plugin')
    expect(message.source.plugin).toBe(PLUGIN_SOURCE.plugin)
  })

  it('文案原样保留（不加工）', () => {
    expect(buildOutboundMessage('现在是08:00，{未求值}').text).toBe('现在是08:00，{未求值}')
  })

  it('带 summary 供界面展示', () => {
    expect(buildOutboundMessage('x').source.summary.length).toBeGreaterThan(0)
  })
})

describe('classifyWarmUpError — 把 host 层异常翻译成可诊断原因', () => {
  it('session/not-found → session-not-found', () => {
    expect(classifyWarmUpError(Object.assign(new Error('x'), { code: 'session/not-found' }))).toBe(
      'session-not-found',
    )
  })

  it('session/agent-busy（子会话被拒）→ subagent-session', () => {
    expect(classifyWarmUpError(Object.assign(new Error('x'), { code: 'session/agent-busy' }))).toBe(
      'subagent-session',
    )
  })

  it('其它异常 → internal', () => {
    expect(classifyWarmUpError(new Error('boom'))).toBe('internal')
    expect(classifyWarmUpError('boom')).toBe('internal')
  })
})

describe('deliver — 正常投递（FR-4）', () => {
  it('根会话、空闲、onBusy=queue → followup 排队', async () => {
    const world = createWorld()
    makeRoot(world, 's1')

    const outcome = await deliver({ ...BASE, sessionId: 's1' }, world.port)

    expect(outcome.kind).toBe('queued')
    expect(world.followups).toHaveLength(1)
    expect(world.followups[0]?.sessionId).toBe('s1')
    expect(world.followups[0]?.message.text).toBe('现在是{time}')
  })

  it('onBusy=queue 且 Agent 正在输出 → 仍然 followup（followup 本身就是排到下一轮）', async () => {
    const world = createWorld()
    makeRoot(world, 's1')
    world.statuses.set('s1', 'running')

    const outcome = await deliver({ ...BASE, sessionId: 's1' }, world.port)

    expect(outcome.kind).toBe('queued')
    expect(world.followups).toHaveLength(1)
  })

  it('onBusy=inject → 用 inject 原语立即注入', async () => {
    const world = createWorld()
    makeRoot(world, 's1')

    const outcome = await deliver({ ...BASE, sessionId: 's1', onBusy: 'inject' }, world.port)

    expect(outcome.kind).toBe('injected')
    expect(world.injections).toHaveLength(1)
    expect(world.followups).toHaveLength(0)
  })
})

describe('deliver — 绝不给子 Agent 投递（FR-4 第 2 条 / T9）', () => {
  it('子 Agent 会话 → 失败，且不产生任何投递', async () => {
    const world = createWorld()
    makeRoot(world, 's1')
    world.subagents.add('s1')

    const outcome = await deliver({ ...BASE, sessionId: 's1' }, world.port)

    expect(outcome).toEqual({ kind: 'failed', reason: 'subagent-session' })
    expect(world.followups).toHaveLength(0)
    expect(world.injections).toHaveLength(0)
  })

  it('即使是 onBusy=inject 也不越界', async () => {
    const world = createWorld()
    makeRoot(world, 's1')
    world.subagents.add('s1')

    await deliver({ ...BASE, sessionId: 's1', onBusy: 'inject' }, world.port)

    expect(world.injections).toHaveLength(0)
  })

  it('live 但不是根 Agent（例如被别的插件拥有的通道 agent）→ 失败', async () => {
    const world = createWorld()
    world.live.add('s1')
    world.statuses.set('s1', 'idle')
    // 注意：没有加进 roots

    const outcome = await deliver({ ...BASE, sessionId: 's1' }, world.port)

    expect(outcome).toEqual({ kind: 'failed', reason: 'not-root' })
    expect(world.followups).toHaveLength(0)
  })
})

describe('deliver — onBusy=skip', () => {
  it('Agent 忙碌 → 跳过（由调用方计入无回应次数，FR-4 第 3 条）', async () => {
    const world = createWorld()
    makeRoot(world, 's1')
    world.statuses.set('s1', 'running')

    const outcome = await deliver({ ...BASE, sessionId: 's1', onBusy: 'skip' }, world.port)

    expect(outcome).toEqual({ kind: 'skipped', reason: 'agent-busy' })
    expect(world.followups).toHaveLength(0)
  })

  it('Agent 空闲 → 照常投递', async () => {
    const world = createWorld()
    makeRoot(world, 's1')

    const outcome = await deliver({ ...BASE, sessionId: 's1', onBusy: 'skip' }, world.port)

    expect(outcome.kind).toBe('queued')
  })
})

describe('deliver — 冷会话与冷唤醒（FR-4 第 7 条）', () => {
  it('冷会话 + coldWake=session-controller → 先唤醒再投递', async () => {
    const world = createWorld()
    // s1 不在 live 里
    const outcome = await deliver({ ...BASE, sessionId: 's1' }, world.port)

    expect(outcome.kind).toBe('queued')
    expect(world.warmUpCalls).toEqual(['s1'])
    expect(world.followups).toHaveLength(1)
  })

  it('冷会话 + coldWake=never → 跳过，保持逾期（与官方 dsh-schedule 一致）', async () => {
    const world = createWorld()

    const outcome = await deliver({ ...BASE, sessionId: 's1', coldWake: 'never' }, world.port)

    expect(outcome).toEqual({ kind: 'skipped', reason: 'not-live' })
    expect(world.warmUpCalls).toHaveLength(0)
    expect(world.followups).toHaveLength(0)
  })

  it('唤醒报 session/not-found → 任务应转 ERROR', async () => {
    const world = createWorld()
    world.warmUpError = Object.assign(new Error('not found'), { code: 'session/not-found' })

    const outcome = await deliver({ ...BASE, sessionId: 's1' }, world.port)

    expect(outcome).toMatchObject({ kind: 'failed', reason: 'session-not-found' })
    // 原始错误文本要保留下来供日志与界面诊断（FR-4 第 4 条：不得静默失败）
    if (outcome.kind === 'failed') expect(outcome.detail).toBe('not found')
  })

  it('唤醒报 session/agent-busy（其实是子会话）→ 按子会话处理', async () => {
    const world = createWorld()
    world.warmUpError = Object.assign(new Error('busy'), { code: 'session/agent-busy' })

    const outcome = await deliver({ ...BASE, sessionId: 's1' }, world.port)

    expect(outcome).toMatchObject({ kind: 'failed', reason: 'subagent-session' })
  })

  it('唤醒成功但结果不是根 Agent → 仍然拒绝', async () => {
    const world = createWorld()
    world.port.warmUp = async () => {
      world.live.add('s1')
      world.statuses.set('s1', 'idle')
      // 没有加进 roots
    }

    const outcome = await deliver({ ...BASE, sessionId: 's1' }, world.port)

    expect(outcome).toEqual({ kind: 'failed', reason: 'not-root' })
  })
})

describe('deliver — 上下文可达（T10 / FR-4 第 7 条）', () => {
  it('投递目标是任务配置的那个会话**本身**，不另起空白会话', async () => {
    const world = createWorld()
    makeRoot(world, 's1')

    await deliver({ ...BASE, sessionId: 's1' }, world.port)

    // 端口只有「按 sessionId 取目标」这一种能力，**根本没有创建会话的出口**——
    // 这正是「主 Agent 能读到该会话完整对话历史」的结构性保证。
    expect(world.followups[0]?.sessionId).toBe('s1')
  })

  it('冷会话唤醒后仍是同一个会话 id（恢复而不是新建）', async () => {
    const world = createWorld()

    await deliver({ ...BASE, sessionId: 's1' }, world.port)

    expect(world.warmUpCalls).toEqual(['s1'])
    expect(world.followups[0]?.sessionId).toBe('s1')
  })
})

describe('deliver — 投递原语抛错', () => {
  it('followup 抛错 → failed/internal，不静默吞掉', async () => {
    const world = createWorld()
    makeRoot(world, 's1')
    world.followupError = new Error('inbox 投影未注册')

    const outcome = await deliver({ ...BASE, sessionId: 's1' }, world.port)

    expect(outcome.kind).toBe('failed')
    if (outcome.kind !== 'failed') return
    expect(outcome.reason).toBe('internal')
    expect(outcome.detail).toContain('inbox')
  })
})
