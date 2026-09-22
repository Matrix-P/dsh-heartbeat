/**
 * 会话选择器的**纯逻辑**（需求 12.5 / 技术设计 10.5）。
 *
 * 两条硬要求在这里落地：
 * 1. **候选必须过滤掉子 Agent 会话**（FR-4 第 2 条：本组件绝不向子 Agent 投递）；
 * 2. **主显示是对话名称，不是 `sessionId`** —— 那串 `im:qq_xxx:dm:...` 只配待在
 *    悬浮提示或复制按钮里。缺标题时用占位文案，绝不回落到 id。
 */

import { describeElapsed } from './view-model.js'
// 分类规则与服务端共用同一份（`src/session-kind.ts`）。本文件只做**展示层**转换：
// 筛子会话（服务端已经筛过一遍，这里是第二道保险）、排最近活跃、把标题折成展示字段。
import type { SessionKind } from '../session-kind.js'

export type { SessionKind }

export interface SessionCandidate {
  readonly sessionId: string
  /** 会话标题 / 对方昵称；取不到时为 `null` */
  readonly title: string | null
  readonly kind: SessionKind
  /** 最近活跃时刻（epoch ms） */
  readonly updatedAt: number
}

export interface SessionOption {
  readonly sessionId: string
  /** **主标题**：对话名称（或占位文案），永不是 sessionId */
  readonly label: string
  /** 副标题：最近活跃的相对时间 */
  readonly sublabel: string
  readonly badge: string | null
  readonly kind: SessionKind
}

export const UNNAMED_SESSION_LABEL = '(未命名会话)'

const BADGE_BY_KIND: Readonly<Partial<Record<SessionKind, string>>> = {
  'plugin-channel': 'IM 会话',
}

/**
 * 把候选会话转成下拉选项：过滤子会话、按最近活跃降序、算出展示字段。
 */
export function toSessionOptions(
  candidates: readonly SessionCandidate[],
  now: number,
): readonly SessionOption[] {
  return [...candidates]
    .filter((candidate) => candidate.kind !== 'subagent')
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .map((candidate) => {
      const title = candidate.title?.trim() ?? ''
      return {
        sessionId: candidate.sessionId,
        label: title === '' ? UNNAMED_SESSION_LABEL : title,
        sublabel: describeElapsed(candidate.updatedAt, now),
        badge: BADGE_BY_KIND[candidate.kind] ?? null,
        kind: candidate.kind,
      }
    })
}
