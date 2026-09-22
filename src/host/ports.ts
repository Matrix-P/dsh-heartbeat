/**
 * host 端口适配（技术设计 7.1）。
 *
 * 这一层把 DSH 的**官方形状**翻译成本组件定义的端口。之所以单独抽出来：
 *
 * 1. `express`/DSH 的 `ctx` 很难造假件，而这一层的输入是**能力函数**，因此可以纯单测；
 * 2. 「只给主 Agent」这条约束在本层落地（官方没有强制门），是最需要测试保护的逻辑；
 * 3. 真正接触 `@deepseek-ai/*` 的只有 `host/dsh.ts` 那薄薄一层胶水。
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'

import type { DeliveryPort, OutboundMessage } from '../delivery/deliver.js'
import type { Cancel, Clock } from '../runtime/clock.js'
import { MAX_TIMER_DELAY_MS } from '../runtime/clock.js'

/** Agent 的最小结构，对应官方 `dsh-agent` 的 `Agent`（`runtime-types.d.ts:143,147`）。 */
export interface AgentLike {
  /** 与 `Session.id` 同值（`dsh-agent lib/types/types.d.ts:11-14`） */
  readonly id: string
  readonly status: 'idle' | 'running'
  readonly session: {
    readonly header: {
      /** 官方唯一取值 `'subagent'`（`dsh-session lib/types/types.d.ts:81`） */
      readonly origin?: 'subagent'
      readonly parentSession?: string
    }
  }
}

/**
 * 从 host 抽出的能力函数。映射关系：
 *
 * | 能力 | 官方 API |
 * | --- | --- |
 * | `getAgent` | `ctx.agents.get(id)` |
 * | `rootAgents` | `ctx.agents.roots()` |
 * | `isOwnedBy` | `ctx.agents.isOwnedBy(id, owner)` |
 * | `followup` | `agent.followup(msg)` |
 * | `inject` | `agent.inject(msg)` |
 * | `resolveAgent` | `ctx.sessionController.resolveAgent(id)` |
 */
export interface AgentCapabilities {
  getAgent(sessionId: string): AgentLike | undefined
  rootAgents(): readonly AgentLike[]
  isOwnedBy(sessionId: string, owner: AgentLike): boolean
  followup(sessionId: string, message: OutboundMessage): void
  inject(sessionId: string, message: OutboundMessage): void
  /** 冷唤醒出口。**只在 host 有长生命周期会话控制器时才提供**（避免 resume 的生命周期耦合，R1） */
  resolveAgent?: (sessionId: string) => Promise<void>
}

/**
 * 把端口消息转成官方 `UserMessage`。
 *
 * **必须**走官方工厂：`id` 与 `role` 由它铸造并深冻结，自己拼一个对象不满足运行时契约。
 */
export function toUserMessage(message: OutboundMessage): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text: message.text }],
    source: message.source,
  })
}

/** 用 host 能力实现投递端口。 */
export function createDeliveryPort(capabilities: AgentCapabilities): DeliveryPort {
  function requireLive(sessionId: string): AgentLike {
    const agent = capabilities.getAgent(sessionId)
    if (agent === undefined) {
      throw new Error(`会话 ${sessionId} 当前没有 live 的 Agent，无法投递`)
    }
    return agent
  }

  const port: DeliveryPort = {
    isLive: (sessionId) => capabilities.getAgent(sessionId) !== undefined,

    isRoot: (sessionId) => capabilities.rootAgents().some((agent) => agent.id === sessionId),

    /**
     * 对应官方 `hasApiSessionSubagentOwner`：
     * `origin === 'subagent'`，或 `parentSession` 指向一个**在运行时拥有它**的父 Agent。
     *
     * 冷会话查不到 header，此时返回 `false`——由 host 层 `resolveAgent` 对子会话
     * 抛 `session/agent-busy` 兜底拒绝（`dsh-api-session-controller lib/types/agent.js:63-70`）。
     */
    isSubagentSession: (sessionId) => {
      const agent = capabilities.getAgent(sessionId)
      if (agent === undefined) return false
      if (agent.session.header.origin === 'subagent') return true

      const parentId = agent.session.header.parentSession
      if (parentId === undefined) return false

      const parent = capabilities.getAgent(parentId)
      return parent !== undefined && capabilities.isOwnedBy(agent.id, parent)
    },

    statusOf: (sessionId) => capabilities.getAgent(sessionId)?.status,

    followup: (sessionId, message) => {
      // 先确认是 live 的 Agent：非 live 时抛错而不是静默丢弃（FR-4 第 4 条）
      requireLive(sessionId)
      capabilities.followup(sessionId, message)
    },

    inject: (sessionId, message) => {
      requireLive(sessionId)
      capabilities.inject(sessionId, message)
    },

    /**
     * 冷唤醒出口。**必须按调用时求值**，不能快照：
     * `sessionController` 属于 `dsh-web-app`，可能在我们的 `apply` 之后才出现，
     * 届时能力才会被补上（见 `host/dsh.ts` 的 R18 说明）。
     * 返回 `undefined` 时编排器会把冷会话判为 `skipped`，而不是误判成 ERROR。
     */
    get warmUp() {
      return capabilities.resolveAgent
    },
  }

  return port
}

/** host 定时器服务的最小结构（对应 `cordis-plugin-timer` 的 `ctx.timeout`）。 */
export interface TimerLike {
  now(): number
  timeout(callback: () => void, delay: number): Cancel
}

/**
 * 用 host 定时器实现 {@link Clock}。
 *
 * 与 `SystemClock` 的区别：延时由 `ctx.timeout` 提供，因此定时器随插件 fiber
 * 自动清理，插件卸载后不会留下野定时器。
 */
export function createClockAdapter(timer: TimerLike): Clock {
  return {
    now: () => timer.now(),

    schedule(at, callback) {
      let cancelled = false
      let cancel: Cancel | null = null

      const arm = (target: number): void => {
        if (cancelled) return
        const delay = Math.max(0, target - timer.now())
        cancel = timer.timeout(
          () => {
            if (cancelled) return
            // 被提前唤醒，或刚才是被上限截断的一段
            if (target - timer.now() > 0) {
              arm(target)
              return
            }
            callback()
          },
          Math.min(delay, MAX_TIMER_DELAY_MS),
        )
      }

      arm(at)

      return () => {
        cancelled = true
        cancel?.()
      }
    },
  }
}
