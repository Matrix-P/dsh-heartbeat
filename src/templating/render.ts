/**
 * 文案占位符渲染（FR-7 第 2 条：**触发时求值**）。
 *
 * 设计要点：
 * - **纯函数**：`now` / `rng` 都由 `RenderContext` 注入，绝不读时钟、不读 `Math.random`。
 *   这样含 `{time}`、`{random}` 的文案都能被确定性断言（FR-7 第 10 条）。
 * - 节点树在配置加载期解析一次并缓存，每次触发只跑本模块的求值。
 * - 时间类变量一律按**任务时区**求值（FR-7 第 4 条）。
 */

import { formatZoned, zonedParts } from '../schedule/zone.js'
import type { PlaceholderName, PlaceholderSpec, TemplateNode } from './parse.js'
import { PLACEHOLDER_SPECS } from './parse.js'

/** 随机源 seam：生产用 `Math.random` 包装，测试注入固定序列。 */
export interface Rng {
  int(minInclusive: number, maxInclusive: number): number
}

export interface RenderTaskFacts {
  readonly id: string
  readonly name: string
  readonly fireCount: number
  readonly noReplyStreak: number
  readonly lastFiredAt: number | null
  readonly nextFireAt: number | null
}

export interface RenderSessionFacts {
  readonly lastUserMsgAt: number | null
}

export interface RenderContext {
  readonly now: number
  readonly timezone: string
  readonly task: RenderTaskFacts
  readonly session: RenderSessionFacts
  readonly rng: Rng
}

/** 0 = 周日，与 `zonedParts().weekday` 口径一致。 */
export const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const

const MINUTE_MS = 60_000
const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

const RANGE_RE = /^(\d+)-(\d+)$/

/** 把时长渲染成人话（`3小时20分钟` / `1天1小时` / `刚刚`）。 */
export function describeDuration(ms: number): string {
  const totalMinutes = Math.floor(ms / MINUTE_MS)
  if (totalMinutes < 1) return '刚刚'
  if (totalMinutes < 60) return `${totalMinutes}分钟`

  const totalHours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (totalHours < 24) {
    return minutes === 0 ? `${totalHours}小时` : `${totalHours}小时${minutes}分钟`
  }

  const days = Math.floor(totalHours / 24)
  const hours = totalHours % 24
  return hours === 0 ? `${days}天` : `${days}天${hours}小时`
}

function parseRange(param: string): { min: number; max: number } {
  const matched = RANGE_RE.exec(param)
  // 参数在解析期已校验；这里只是兜底，落到默认范围而不是抛错。
  if (matched === null) return { min: 1, max: 100 }
  return { min: Number(matched[1] as string), max: Number(matched[2] as string) }
}

function defaultParamOf(name: PlaceholderName): string {
  // 显式标注为 PlaceholderSpec：联合类型里 "none" 类成员没有 defaultParam 字段
  const spec: PlaceholderSpec = PLACEHOLDER_SPECS[name]
  return spec.defaultParam ?? 'YYYY-MM-DD HH:mm'
}

function formatInstant(instant: number, context: RenderContext, format: string): string {
  return formatZoned(instant, context.timezone, format)
}

function formatMaybeInstant(
  instant: number | null,
  context: RenderContext,
  format: string,
): string {
  return instant === null ? '' : formatInstant(instant, context, format)
}

function renderVariable(
  name: PlaceholderName,
  param: string | null,
  context: RenderContext,
): string {
  const format = param ?? defaultParamOf(name)

  switch (name) {
    case 'time':
    case 'date':
    case 'datetime':
      return formatInstant(context.now, context, format)

    case 'weekday':
      return WEEKDAY_LABELS[zonedParts(context.now, context.timezone).weekday] ?? ''

    case 'taskId':
      return context.task.id

    case 'taskName':
      return context.task.name.length > 0 ? context.task.name : context.task.id

    case 'fireCount':
      return String(context.task.fireCount)

    case 'noReplyStreak':
      return String(context.task.noReplyStreak)

    case 'lastFiredAt':
      return formatMaybeInstant(context.task.lastFiredAt, context, format)

    case 'nextFireAt':
      return formatMaybeInstant(context.task.nextFireAt, context, format)

    case 'lastUserMsgAt':
      return formatMaybeInstant(context.session.lastUserMsgAt, context, format)

    case 'sinceLastUserMsg':
      return context.session.lastUserMsgAt === null
        ? '从未'
        : describeDuration(context.now - context.session.lastUserMsgAt)

    case 'random': {
      const { min, max } = parseRange(format)
      return String(context.rng.int(min, max))
    }
  }
}

/** 对解析好的节点树求值，得到最终要投递的文案。 */
export function renderTemplate(nodes: readonly TemplateNode[], context: RenderContext): string {
  let out = ''
  for (const node of nodes) {
    out += node.kind === 'text' ? node.value : renderVariable(node.name, node.param, context)
  }
  return out
}

/** 生产用随机源。测试请注入固定实现。 */
export function systemRng(): Rng {
  return {
    int: (min, max) => min + Math.floor(Math.random() * (max - min + 1)),
  }
}

export { DAY_MS, HOUR_MS, MINUTE_MS }
