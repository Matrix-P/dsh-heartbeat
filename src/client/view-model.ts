/**
 * 设置界面的**展示模型**（技术设计 10.4）—— 纯函数，与 React / DOM 无关，因此可以单测。
 *
 * 把 `TaskSnapshot` 翻译成"人能看懂的一行"，包括：
 * - 五态徽标的文案与色调
 * - 下次触发 / 上次触发的相对时间
 * - 异常与静默原因的**中文解释**（内部 code 不该直接丢给用户看）
 */

import type { TaskSnapshot } from '../runtime/orchestrator.js'
import type { TaskStatus } from '../runtime/task-state.js'
import { describeDuration } from '../templating/render.js'

export type StatusTone = 'ok' | 'muted' | 'warn' | 'danger' | 'done'

export interface StatusView {
  readonly tone: StatusTone
  readonly label: string
}

const STATUS_VIEWS: Readonly<Record<TaskStatus, StatusView>> = {
  armed: { tone: 'ok', label: '运行中' },
  disabled: { tone: 'muted', label: '已停用' },
  suspended: { tone: 'warn', label: '已静默' },
  completed: { tone: 'done', label: '已完成' },
  error: { tone: 'danger', label: '异常' },
}

export function describeStatus(status: TaskStatus): StatusView {
  return STATUS_VIEWS[status]
}

/** 过去某时刻的相对描述。`null` 表示从未发生。 */
export function describeElapsed(from: number | null, now: number): string {
  if (from === null) return '从未'
  const base = describeDuration(now - from)
  return base === '刚刚' ? '刚刚' : `${base}前`
}

/** 未来某时刻的相对描述。`null` 表示没有下一次；已过期时给「即将」。 */
export function describeEta(at: number | null, now: number): string {
  if (at === null) return '—'
  const base = describeDuration(at - now)
  return base === '刚刚' ? '即将' : `${base}后`
}

/**
 * 内部原因 code → 用户能看懂的话。
 * **未知 code 原样返回**，不隐藏信息（宁可难看也不要吞掉线索）。
 */
const ERROR_EXPLAIN: Readonly<Record<string, string>> = {
  'once-expired': 'once 任务的时刻已过，请修改时间或停用该任务',
  'session-not-found': '目标会话不存在或已被删除，请重新选择会话',
  'subagent-session': '目标是子 Agent 会话，本组件不会向子 Agent 投递',
  'not-root': '目标不是该会话的主 Agent',
}

export function explainError(reason: string | null): string | null {
  if (reason === null || reason === '') return null
  return ERROR_EXPLAIN[reason] ?? reason
}

export function describeNoReply(streak: number, max: number): string {
  return max <= 0 ? '不静默' : `${streak}/${max}`
}

export interface TaskRowView {
  readonly id: string
  readonly name: string
  readonly status: StatusView
  readonly nextFireText: string
  readonly lastFiredText: string
  readonly fireCountText: string
  readonly noReplyText: string
  /** 需要解释「为什么没触发 / 为什么停下来了」时的一句话 */
  readonly notice: string | null
}

/**
 * 拼装列表行。
 *
 * @param noReplyMax 该任务的 `noReply.max`（来自配置，快照里没有）
 */
export function toTaskRowView(
  snapshot: TaskSnapshot,
  now: number,
  noReplyMax: number,
): TaskRowView {
  return {
    id: snapshot.id,
    name: snapshot.name === '' ? snapshot.id : snapshot.name,
    status: describeStatus(snapshot.status),
    nextFireText: describeEta(snapshot.nextFireAt, now),
    lastFiredText: describeElapsed(snapshot.lastFiredAt, now),
    fireCountText: String(snapshot.fireCount),
    noReplyText: describeNoReply(snapshot.noReplyStreak, noReplyMax),
    notice: buildNotice(snapshot),
  }
}

/** 提示语优先级：**异常 > 静默 > FR-8 输出抑制**。 */
function buildNotice(snapshot: TaskSnapshot): string | null {
  if (snapshot.status === 'error' || snapshot.errorReason !== null) {
    return explainError(snapshot.errorReason) ?? '任务处于异常状态'
  }

  if (snapshot.status === 'suspended') {
    const reason = snapshot.suspendReason ?? '连续无回应，已自动静默'
    return `${reason}；回复任意消息即可恢复`
  }

  if (snapshot.supersededBy === 'agent-busy') {
    return '模型正在输出，本次顺延到它说完之后再计时'
  }

  return null
}
