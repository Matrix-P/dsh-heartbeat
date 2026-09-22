/**
 * 时长文本解析（需求 5.1：`30m` / `2h` / `90s`）。
 *
 * 设计取舍（技术设计 3.3 节）：
 * - 只接受「十进制整数 + 小写单位」，拒绝小数（会产生亚分钟值）、负数、零、
 *   缺失单位、复合单位（`1h30m`）与单位前置。
 * - `parseDuration` 是纯解析；「间隔最小 1 分钟」这条领域约束放在
 *   `parseIntervalDuration`，因为 `noReply.window` 这类时长不受该下限约束。
 */

/** 时长单位 → 毫秒 */
const UNIT_MS = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
} as const

type DurationUnit = keyof typeof UNIT_MS

/** 时长语法：非负十进制整数 + 小写单位 */
const DURATION_RE = /^(\d+)(s|m|h)$/

/** 间隔类配置允许的最小值：1 分钟（FR-2 第 1 条：不接受亚分钟配置） */
export const MIN_INTERVAL_MS = 60_000

/** 时长文本非法时抛出。字段路径由调用方（配置校验器）补上。 */
export class DurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DurationError'
  }
}

/** 把原始输入渲染进错误信息，空串要看得见，便于定位。 */
function describe(text: string): string {
  return text.length === 0 ? '（空字符串）' : JSON.stringify(text)
}

/**
 * 解析时长文本为毫秒。
 *
 * @throws {DurationError} 语法非法、值为 0 或超出安全整数范围时
 */
export function parseDuration(text: string): number {
  const matched = DURATION_RE.exec(text.trim())
  if (matched === null) {
    throw new DurationError(
      `非法时长 ${describe(text)}：应为「整数 + 单位」，单位支持 s / m / h（例如 90s、30m、2h）`,
    )
  }

  const digits = matched[1] as string
  const unit = matched[2] as DurationUnit
  const value = Number(digits) * UNIT_MS[unit]

  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new DurationError(`非法时长 ${describe(text)}：必须是大于 0 的安全整数毫秒`)
  }

  return value
}

/**
 * 解析「间隔」时长，额外要求不小于 1 分钟（FR-2 第 1 条）。
 *
 * @throws {DurationError} 语法非法，或小于 {@link MIN_INTERVAL_MS}
 */
export function parseIntervalDuration(text: string): number {
  const ms = parseDuration(text)
  if (ms < MIN_INTERVAL_MS) {
    throw new DurationError(
      `非法间隔 ${describe(text)}：最小粒度为 1 分钟（60s），不接受亚分钟配置`,
    )
  }
  return ms
}
