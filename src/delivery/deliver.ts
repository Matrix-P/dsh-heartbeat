/**
 * 投递层（FR-4）：把一条已经渲染好的文案投递给**目标会话的主 Agent**。
 *
 * 这一层封装了三个容易写错的事实（技术设计 7 章）：
 *
 * 1. **官方没有「只给主 Agent」的强制门**：`agent.followup()` 对子 Agent 一样成功，
 *    所以根过滤必须由我们自己做（`isRoot` + `isSubagentSession` 两道检查）。
 * 2. **消息来源必须标 `form: 'notice'`**：否则官方客户端会把它渲染成**用户自己的
 *    气泡**，用户会以为那句话是自己说的。
 * 3. **冷唤醒有所有权陷阱**：`ctx.agents.resume()` 会把被唤醒 Agent 的生命周期绑到
 *    调用方 fiber，插件卸载会连带收掉会话。所以这里只接受 `warmUp` 这一个出口，
 *    由 host 适配层决定实现（v0.1 只用 `sessionController.resolveAgent`）。
 *
 * 本模块**不直接依赖 DSH**：所有外部能力通过 `DeliveryPort` 注入，因此可以纯假件测试。
 */

import type { ColdWake, OnBusy } from '../config.js'

export const PLUGIN_NAME = 'heartbeat'

/** 与官方 `MessageSourceMap` 的 `plugin` 支对应（`dsh-llm lib/types/message.d.ts:98-101`）。 */
export interface OutboundSource {
  readonly kind: 'plugin'
  readonly plugin: string
  /** 决定客户端如何呈现；`'notice'` = 系统提示而不是用户气泡 */
  readonly form: 'notice'
  readonly summary: string
}

export interface OutboundMessage {
  readonly text: string
  readonly source: OutboundSource
}

export const PLUGIN_SOURCE: OutboundSource = {
  kind: 'plugin',
  plugin: PLUGIN_NAME,
  form: 'notice',
  summary: '心跳提醒',
}

/** 构造投递消息。**组件不加工文案**（D-1）：`text` 原样透传。 */
export function buildOutboundMessage(text: string): OutboundMessage {
  return { text, source: PLUGIN_SOURCE }
}

/**
 * 投递端口：由 host 适配层实现，映射到 DSH 官方 API。
 *
 * | 方法 | 对应的官方能力 |
 * | --- | --- |
 * | `isLive(id)` | `ctx.agents.get(id) !== undefined`（只看 live） |
 * | `isRoot(id)` | `ctx.agents.roots().some(a => a.id === id)` |
 * | `isSubagentSession(id)` | `hasApiSessionSubagentOwner(ctx, session, agent)` |
 * | `warmUp(id)` | `ctx.sessionController.resolveAgent(id)`（失败即抛） |
 * | `statusOf(id)` | `agent.status`（`'idle' \| 'running'`） |
 * | `followup(id, msg)` | `agent.followup(createUserMessage(msg))` |
 * | `inject(id, msg)` | `agent.inject(createUserMessage(msg))` |
 */
export interface DeliveryPort {
  isLive(sessionId: string): boolean
  isRoot(sessionId: string): boolean
  isSubagentSession(sessionId: string): boolean
  warmUp?(sessionId: string): Promise<void>
  statusOf(sessionId: string): 'idle' | 'running' | undefined
  followup(sessionId: string, message: OutboundMessage): void
  inject(sessionId: string, message: OutboundMessage): void
}

export type DeliveryFailure =
  | 'session-not-found'
  | 'subagent-session'
  | 'not-root'
  | 'internal'

export type DeliveryOutcome =
  | { readonly kind: 'queued'; readonly message: OutboundMessage }
  | { readonly kind: 'injected'; readonly message: OutboundMessage }
  | { readonly kind: 'skipped'; readonly reason: 'not-live' | 'agent-busy' }
  | { readonly kind: 'failed'; readonly reason: DeliveryFailure; readonly detail?: string }

export interface DeliverInput {
  readonly sessionId: string
  /** 已经过占位符求值的最终文案 */
  readonly text: string
  readonly onBusy: OnBusy
  readonly coldWake: ColdWake
}

/**
 * 把 host 层 `resolveAgent` 的异常翻译成可诊断原因。
 *
 * 官方 host 层在失败时**抛** `RemoteError`（`dsh-api-session-controller lib/index.js:879-883`），
 * 其 `code` 为 `session/not-found` / `session/agent-busy` / `gateway/internal`。
 */
export function classifyWarmUpError(error: unknown): DeliveryFailure {
  const code =
    typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined

  if (code === 'session/not-found') return 'session-not-found'
  // 官方对子会话拒绝通用投递时给的就是这个码（`agent.js:63-70`）
  if (code === 'session/agent-busy') return 'subagent-session'
  return 'internal'
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 目标合法性检查：必须是**根 Agent**，且**不是子 Agent 会话**。 */
function rejectInvalidTarget(sessionId: string, port: DeliveryPort): DeliveryOutcome | null {
  if (port.isSubagentSession(sessionId)) {
    return { kind: 'failed', reason: 'subagent-session' }
  }
  if (!port.isRoot(sessionId)) {
    return { kind: 'failed', reason: 'not-root' }
  }
  return null
}

/**
 * 投递一次。返回结构化结果，调用方据此更新任务状态并写日志（FR-6 第 3 条）。
 *
 * 注意：`queued` 只表示**已入队**，不表示模型已经生成或被用户读到
 * （官方 `dsh-schedule` README 原文：「dispatch 表示 follow-up 已入队并被记录，
 * 不表示模型成功」）。
 */
export async function deliver(input: DeliverInput, port: DeliveryPort): Promise<DeliveryOutcome> {
  const { sessionId } = input

  if (!port.isLive(sessionId)) {
    if (input.coldWake === 'never' || port.warmUp === undefined) {
      // 与官方 dsh-schedule 的既定行为一致：任务保持逾期，不静默失败
      return { kind: 'skipped', reason: 'not-live' }
    }

    try {
      await port.warmUp(sessionId)
    } catch (error) {
      return {
        kind: 'failed',
        reason: classifyWarmUpError(error),
        detail: describeError(error),
      }
    }

    if (!port.isLive(sessionId)) {
      return { kind: 'skipped', reason: 'not-live' }
    }
  }

  const invalid = rejectInvalidTarget(sessionId, port)
  if (invalid !== null) return invalid

  // onBusy=skip 只在「此刻正在输出」时跳过，并交由调用方计入无回应次数
  if (input.onBusy === 'skip' && port.statusOf(sessionId) === 'running') {
    return { kind: 'skipped', reason: 'agent-busy' }
  }

  const message = buildOutboundMessage(input.text)

  try {
    if (input.onBusy === 'inject') {
      port.inject(sessionId, message)
      return { kind: 'injected', message }
    }
    // queue（默认）：followup 本身就是「排到下一轮」，天然不打断当前回合
    port.followup(sessionId, message)
    return { kind: 'queued', message }
  } catch (error) {
    return { kind: 'failed', reason: 'internal', detail: describeError(error) }
  }
}
