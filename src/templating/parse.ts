/**
 * 文案占位符解析（FR-7）——**加载期**的词法解析与静态校验。
 *
 * 职责边界：
 * - 本模块只做**解析与校验**，不求值；求值在 `render.ts`。
 * - 校验必须**一次报出全部错误**（需求 8.6），并带上字符偏移，便于界面定位。
 * - 求值时机是「每次触发时」，所以本模块产出的节点树会被缓存复用，
 *   而 `render.ts` 每次触发重新跑一遍。
 */

import { validateTimeFormat } from '../schedule/zone.js'

/** 占位符参数的语法类别。 */
export type PlaceholderParamKind = 'none' | 'time-format' | 'range'

export interface PlaceholderSpec {
  readonly param: PlaceholderParamKind
  /** 参数缺省时使用的值（时间格式串 / 随机范围） */
  readonly defaultParam?: string
  readonly description: string
}

/**
 * 占位符白名单（需求 FR-7 第 3 条 / D-11，共 13 个）。
 *
 * 顺序即界面上「占位符辅助」的展示顺序。
 */
export const PLACEHOLDER_SPECS = {
  time: { param: 'time-format', defaultParam: 'HH:mm', description: '当前时刻' },
  date: { param: 'time-format', defaultParam: 'YYYY-MM-DD', description: '当前日期' },
  datetime: {
    param: 'time-format',
    defaultParam: 'YYYY-MM-DD HH:mm',
    description: '当前日期与时间',
  },
  weekday: { param: 'none', description: '星期几（周一…周日）' },
  taskId: { param: 'none', description: '任务 ID' },
  taskName: { param: 'none', description: '任务展示名' },
  fireCount: { param: 'none', description: '含本次在内的累计触发次数' },
  noReplyStreak: { param: 'none', description: '当前连续无回应次数' },
  lastFiredAt: {
    param: 'time-format',
    defaultParam: 'YYYY-MM-DD HH:mm',
    description: '上次触发时间',
  },
  nextFireAt: {
    param: 'time-format',
    defaultParam: 'YYYY-MM-DD HH:mm',
    description: '下次计划触发时间',
  },
  sinceLastUserMsg: { param: 'none', description: '距用户上次发言的时长' },
  lastUserMsgAt: {
    param: 'time-format',
    defaultParam: 'YYYY-MM-DD HH:mm',
    description: '用户上次发言时刻',
  },
  random: { param: 'range', defaultParam: '1-100', description: '随机整数（可指定范围）' },
} as const satisfies Record<string, PlaceholderSpec>

export type PlaceholderName = keyof typeof PLACEHOLDER_SPECS

export const PLACEHOLDER_NAMES = Object.keys(PLACEHOLDER_SPECS) as readonly PlaceholderName[]

/** 解析结果的一环：字面文本或一个变量引用。 */
export type TemplateNode =
  | { readonly kind: 'text'; readonly value: string }
  | {
      readonly kind: 'variable'
      readonly name: PlaceholderName
      /** 原始参数文本；未写参数时为 `null` */
      readonly param: string | null
      /** 该占位符起始的字符偏移 */
      readonly offset: number
    }

export interface TemplateError {
  readonly offset: number
  readonly length: number
  readonly message: string
}

export type ParseTemplateResult =
  | { readonly ok: true; readonly nodes: readonly TemplateNode[] }
  | { readonly ok: false; readonly errors: readonly TemplateError[] }

/** 随机范围参数的最大边界，防止写出天文数字。 */
const MAX_RANDOM_BOUND = 1_000_000

const RANGE_RE = /^(\d+)-(\d+)$/

function isPlaceholderName(name: string): name is PlaceholderName {
  return Object.prototype.hasOwnProperty.call(PLACEHOLDER_SPECS, name)
}

function validateRange(param: string): string | null {
  const matched = RANGE_RE.exec(param)
  if (matched === null) {
    return `random 的范围参数应为「最小-最大」（例如 1-100），收到 ${JSON.stringify(param)}`
  }

  const min = Number(matched[1] as string)
  const max = Number(matched[2] as string)

  if (max < min) {
    return `random 的范围参数里最大值小于最小值：${JSON.stringify(param)}`
  }
  if (max > MAX_RANDOM_BOUND) {
    return `random 的范围参数过大（上限 ${MAX_RANDOM_BOUND}）：${JSON.stringify(param)}`
  }
  return null
}

function parsePlaceholder(
  inner: string,
  offset: number,
  errors: TemplateError[],
): TemplateNode | null {
  const fail = (message: string): null => {
    errors.push({ offset, length: inner.length + 2, message })
    return null
  }

  if (inner.length === 0) {
    return fail('空的占位符 "{}"：请填写变量名')
  }

  const colon = inner.indexOf(':')
  const name = colon < 0 ? inner : inner.slice(0, colon)
  const param = colon < 0 ? null : inner.slice(colon + 1)

  if (!isPlaceholderName(name)) {
    return fail(
      `未知的占位符 "${name}"：可用变量为 ${PLACEHOLDER_NAMES.join(' / ')}（要输出字面花括号请写 "{{" / "}}"）`,
    )
  }

  const spec: PlaceholderSpec = PLACEHOLDER_SPECS[name]

  if (param === null) {
    return { kind: 'variable', name, param: null, offset }
  }

  if (param.length === 0) {
    return fail(`占位符 "${name}" 的参数为空：要么去掉 ":"，要么填写参数`)
  }

  if (spec.param === 'none') {
    return fail(`占位符 "${name}" 不接受参数，但它带了 "${param}"`)
  }

  if (spec.param === 'time-format') {
    const problem = validateTimeFormat(param)
    if (problem !== null) return fail(`占位符 "${name}" 的格式串有误：${problem}`)
  } else {
    const problem = validateRange(param)
    if (problem !== null) return fail(problem)
  }

  return { kind: 'variable', name, param, offset }
}

/**
 * 解析并静态校验文案模板。
 *
 * 语法（FR-7 第 1 / 5 / 6 / 7 条）：
 * - `{{` → 字面 `{`；`}}` → 字面 `}`
 * - `{name}` / `{name:param}` → 变量
 * - 落单的 `{` / `}` → 错误
 *
 * @returns 成功时返回节点树；失败时返回**全部**错误（不是第一条）
 */
export function parseTemplate(text: string): ParseTemplateResult {
  const nodes: TemplateNode[] = []
  const errors: TemplateError[] = []
  let buffer = ''
  let index = 0

  const flush = (): void => {
    if (buffer.length > 0) {
      nodes.push({ kind: 'text', value: buffer })
      buffer = ''
    }
  }

  while (index < text.length) {
    const ch = text.charAt(index)

    if (ch === '{' && text.charAt(index + 1) === '{') {
      buffer += '{'
      index += 2
      continue
    }

    if (ch === '}' && text.charAt(index + 1) === '}') {
      buffer += '}'
      index += 2
      continue
    }

    if (ch === '{') {
      const close = text.indexOf('}', index + 1)
      flush()
      if (close < 0) {
        errors.push({
          offset: index,
          length: 1,
          message: '未闭合的 "{"：占位符必须以 "}" 结束（要输出字面 "{" 请写 "{{"）',
        })
        index += 1
        continue
      }
      const node = parsePlaceholder(text.slice(index + 1, close), index, errors)
      if (node !== null) nodes.push(node)
      index = close + 1
      continue
    }

    if (ch === '}') {
      flush()
      errors.push({
        offset: index,
        length: 1,
        message: '落单的 "}"（要输出字面 "}" 请写 "}}"）',
      })
      index += 1
      continue
    }

    buffer += ch
    index += 1
  }

  flush()

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, nodes }
}
