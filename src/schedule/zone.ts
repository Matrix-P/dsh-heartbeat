/**
 * 时区工具（技术设计 5.3 节）。
 *
 * 背景（三个坏消息之二）：DSH 官方的 `@deepseek-ai/dsh-util-time` 只导出一个
 * `canonicalClientTimeZone()`，仅做校验与规范化，**不做任何换算**；官方
 * `dsh-schedule` 里的换算代码是私有实现、未导出。因此本模块自行实现。
 *
 * 约束：全部基于 `Intl.DateTimeFormat`，零第三方依赖、纯函数、可离线测试。
 * 所有函数都不读系统时钟（时刻一律由调用方以 `instant` 传入），以保证可测性。
 */

/** 时区名非法，或请求的墙上时刻在该时区不存在时抛出。 */
export class ZoneError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ZoneError'
  }
}

/** 某绝对时刻在某时区下的“墙上时间”快照。 */
export interface ZonedParts {
  readonly year: number
  /** 1–12 */
  readonly month: number
  /** 1–31 */
  readonly day: number
  /** 0–23 */
  readonly hour: number
  readonly minute: number
  readonly second: number
  /** 0 = 周日 … 6 = 周六 */
  readonly weekday: number
  /** 该时刻该时区相对 UTC 的偏移（分钟），东八区为 480 */
  readonly offsetMinutes: number
}

/** 不带时区的“墙上时间”，用于 `zonedInstant` 反解。 */
export interface WallTime {
  readonly year: number
  readonly month: number
  readonly day: number
  readonly hour: number
  readonly minute: number
  readonly second: number
}

const WEEKDAY_INDEX: Readonly<Record<string, number>> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
}

const formatterCache = new Map<string, Intl.DateTimeFormat>()

/**
 * 取（并缓存）某时区的 formatter。构造失败即表示时区名非法。
 *
 * @throws {ZoneError} 时区名非法
 */
function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone)
  if (cached !== undefined) return cached

  let formatter: Intl.DateTimeFormat
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    })
  } catch (error) {
    throw new ZoneError(
      `非法时区 ${JSON.stringify(timeZone)}：${error instanceof Error ? error.message : String(error)}`,
    )
  }

  formatterCache.set(timeZone, formatter)
  return formatter
}

/** 把绝对时刻按指定时区拆成墙上时间分量。 */
export function zonedParts(instant: number, timeZone: string): ZonedParts {
  // 归整到整秒：所有现役时区的偏移都是整分钟，因此整秒精度足以精确求偏移。
  const wholeSeconds = Math.floor(instant / 1_000) * 1_000

  const fields = new Map<string, string>()
  for (const part of formatterFor(timeZone).formatToParts(wholeSeconds)) {
    if (part.type !== 'literal') fields.set(part.type, part.value)
  }

  const year = Number(fields.get('year'))
  const month = Number(fields.get('month'))
  const day = Number(fields.get('day'))
  const hour = Number(fields.get('hour'))
  const minute = Number(fields.get('minute'))
  const second = Number(fields.get('second'))
  const weekday = WEEKDAY_INDEX[fields.get('weekday') ?? '']

  if (
    weekday === undefined ||
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    !Number.isInteger(second)
  ) {
    throw new ZoneError(`无法解析 ${timeZone} 的墙上时间（Intl 返回了意外字段）`)
  }

  const asUtc = Date.UTC(year, month - 1, day, hour, minute, second)
  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    weekday,
    offsetMinutes: Math.round((asUtc - wholeSeconds) / 60_000),
  }
}

function sameWall(parts: ZonedParts, wall: WallTime): boolean {
  return (
    parts.year === wall.year &&
    parts.month === wall.month &&
    parts.day === wall.day &&
    parts.hour === wall.hour &&
    parts.minute === wall.minute &&
    parts.second === wall.second
  )
}

function describeWall(wall: WallTime): string {
  const pad = (n: number, len = 2) => String(n).padStart(len, '0')
  return `${wall.year}-${pad(wall.month)}-${pad(wall.day)} ${pad(wall.hour)}:${pad(wall.minute)}:${pad(wall.second)}`
}

/**
 * 把某时区的墙上时间反解为绝对时刻。
 *
 * DST 语义（需求第 7 章要求显式定义并测试）：
 * - **重叠**（回拨，同一墙上时间出现两次）→ 取**较早**的一次；
 * - **间隙**（前拨，该墙上时间不存在）→ **抛 `ZoneError`**，不静默偏移。
 *
 * @throws {ZoneError} 时区非法，或该墙上时刻在此时区不存在
 */
export function zonedInstant(wall: WallTime, timeZone: string): number {
  const guess = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
    wall.second,
  )

  // 用两个候选偏移覆盖 DST 两侧：先按 guess 的偏移试，再用结果的偏移修正一次。
  const firstOffset = zonedParts(guess, timeZone).offsetMinutes
  const first = guess - firstOffset * 60_000
  const secondOffset = zonedParts(first, timeZone).offsetMinutes
  const second = guess - secondOffset * 60_000

  const candidates = first === second ? [first] : [first, second]
  const matches = candidates.filter((candidate) => sameWall(zonedParts(candidate, timeZone), wall))

  if (matches.length === 0) {
    throw new ZoneError(
      `时区 ${timeZone} 中不存在墙上时刻 ${describeWall(wall)}（夏令时前拨造成的间隙）`,
    )
  }

  return Math.min(...matches)
}

/**
 * 校验并规范化时区名。
 *
 * 空 / 未设置 → 返回回退值；**非空但非法 → 抛错**（不静默回退），
 * 以便配置校验把问题一次性报出来（需求 8.6）。
 *
 * @throws {ZoneError} 时区名非空但非法，或回退值非法
 */
export function normalizeZone(timeZone: string | undefined, fallback: string): string {
  const trimmed = timeZone?.trim() ?? ''
  const target = trimmed === '' ? fallback.trim() : trimmed

  if (target === '') {
    throw new ZoneError('时区既未配置、回退值也是空字符串')
  }
  return formatterFor(target).resolvedOptions().timeZone
}

/** 系统默认时区（IANA 名）。 */
export function systemTimeZone(): string {
  const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone
  return resolved === '' ? 'UTC' : resolved
}

/** 支持的格式 token。 */
export const TIME_FORMAT_TOKENS = [
  'YYYY',
  'MM',
  'M',
  'DD',
  'D',
  'HH',
  'H',
  'mm',
  'm',
  'ss',
  's',
] as const

export type TimeFormatToken = (typeof TIME_FORMAT_TOKENS)[number]

/** 连续的同名 ASCII 字母视为一个 token 候选；是否被接受由 token 表决定。 */
const TOKEN_RE = /^([A-Za-z])\1*/

const BRACKET_OPEN = '['
const BRACKET_CLOSE = ']'

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0')
}

/** 渲染单个 token；无法识别时原样返回（严格校验是 `validateTimeFormat` 的职责）。 */
function renderToken(token: string, parts: ZonedParts): string {
  switch (token) {
    case 'YYYY':
      return pad(parts.year, 4)
    case 'MM':
      return pad(parts.month, 2)
    case 'M':
      return String(parts.month)
    case 'DD':
      return pad(parts.day, 2)
    case 'D':
      return String(parts.day)
    case 'HH':
      return pad(parts.hour, 2)
    case 'H':
      return String(parts.hour)
    case 'mm':
      return pad(parts.minute, 2)
    case 'm':
      return String(parts.minute)
    case 'ss':
      return pad(parts.second, 2)
    case 's':
      return String(parts.second)
    default:
      return token
  }
}

/**
 * 按格式串渲染某时刻在某时区下的墙上时间。
 *
 * - token：`YYYY` `MM`/`M` `DD`/`D` `HH`/`H` `mm`/`m` `ss`/`s`
 * - `[任意文本]` 内的内容按字面输出（用于 ISO 的 `T` 之类）
 * - 其余字符（含中文）原样输出；**不认识的字母串也原样输出**，
 *   严格拒绝由 `validateTimeFormat` 在配置加载期完成
 */
export function formatZoned(instant: number, timeZone: string, pattern: string): string {
  const parts = zonedParts(instant, timeZone)
  let out = ''
  let index = 0

  while (index < pattern.length) {
    const ch = pattern.charAt(index)

    if (ch === BRACKET_OPEN) {
      const close = pattern.indexOf(BRACKET_CLOSE, index + 1)
      if (close >= 0) {
        out += pattern.slice(index + 1, close)
        index = close + 1
        continue
      }
      // 未闭合：按字面输出，交由 validateTimeFormat 报错
      out += ch
      index += 1
      continue
    }

    const matched = TOKEN_RE.exec(pattern.slice(index))
    if (matched !== null) {
      const token = matched[0] as string
      out += renderToken(token, parts)
      index += token.length
      continue
    }

    out += ch
    index += 1
  }

  return out
}

/**
 * 加载期校验时间格式串（FR-7 第 6 条：配置错误要在加载时一次性报出）。
 *
 * 规则：不允许出现「不认识的 ASCII 字母串」——这样 `hh:mm`、`YYYY-MM-DDTHH:mm`
 * 这类笔误会被当场抓住，而不是静默地把 `hh` 当成字面量输出。想在格式里放字面
 * 字母，用 `[T]` 转义。
 *
 * @returns `null` 表示合法；否则返回错误说明
 */
export function validateTimeFormat(format: string): string | null {
  if (format.length === 0) return '时间格式串不能为空'

  let index = 0
  let sawToken = false

  while (index < format.length) {
    const ch = format.charAt(index)

    if (ch === BRACKET_OPEN) {
      const close = format.indexOf(BRACKET_CLOSE, index + 1)
      if (close < 0) return `时间格式串里的 "${BRACKET_OPEN}" 没有闭合（位置 ${index}）`
      index = close + 1
      continue
    }

    const matched = TOKEN_RE.exec(format.slice(index))
    if (matched !== null) {
      const token = matched[0] as string
      if (!(TIME_FORMAT_TOKENS as readonly string[]).includes(token)) {
        return `时间格式串里的 "${token}" 不是可识别的 token；支持 ${TIME_FORMAT_TOKENS.join(' / ')}，字面字母请写成 [${token}]`
      }
      sawToken = true
      index += token.length
      continue
    }

    index += 1
  }

  if (!sawToken) return '时间格式串至少需要包含一个 token（如 HH、mm）'
  return null
}
