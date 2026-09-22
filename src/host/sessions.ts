/**
 * 会话候选的 **host 侧装配**（设计 10.2 / 10.5）。
 *
 * 为什么在 host 做：设计 10.5 指定的数据来源（`ctx.sessionQuery.listSessions` +
 * `readTitleSnapshots`）是**服务端**能力，浏览器里没有；而运行期数据本来就走
 * `/api/heartbeat/*` 这条只读通道（10.2 的通道拆分）。
 *
 * 本模块只做**纯映射**：官方对象由 `host/dsh.ts` 取出来喂进来，所以可以完全离线单测。
 *
 * 三条硬要求：
 * 1. **子会话必须在服务端就筛掉**（FR-4 第 2 条）——不能只靠界面过滤；
 * 2. **主标题是对话名称，不是 `sessionId`**（12.5 第 3 条）：取不到标题时给 `null`，
 *    由客户端回落占位文案，**绝不把 id 当标题**；
 * 3. 按最近活跃降序，界面直接可用。
 */

import type { SessionKind } from '../session-kind.js'
import { classifySession } from '../session-kind.js'

/** 线上形状 —— 与 `client/session-picker.ts` 的 `SessionCandidate` 一一对应。 */
export interface SessionCandidatePayload {
  readonly sessionId: string
  readonly title: string | null
  readonly kind: SessionKind
  readonly updatedAt: number
}

/** 官方 `SessionRecord` 的结构子集（`dsh-session-query lib/types/types.d.ts:14`）。 */
export interface SessionRecordLike {
  readonly header: {
    readonly id: unknown
    readonly origin?: string
    readonly parentSession?: unknown
    readonly createdAt?: number
  }
}

/** 官方 `SessionTitleObservationResult` / `SessionTitleObservation` 的结构子集。 */
export interface TitleObservationLike {
  readonly ok?: boolean
  readonly sessionId?: unknown
  readonly value?: {
    readonly title?: {
      readonly title?: unknown
      readonly updatedAt?: unknown
    }
  }
}

interface ResolvedTitle {
  readonly title: string
  readonly updatedAt: number
}

function readTitles(
  observations: readonly TitleObservationLike[],
): ReadonlyMap<string, ResolvedTitle> {
  const byId = new Map<string, ResolvedTitle>()

  for (const observation of observations) {
    if (observation.ok === false) continue
    if (observation.sessionId === undefined) continue

    const snapshot = observation.value?.title
    if (snapshot === undefined) continue
    if (typeof snapshot.title !== 'string' || snapshot.title.trim() === '') continue

    byId.set(String(observation.sessionId), {
      title: snapshot.title,
      updatedAt: typeof snapshot.updatedAt === 'number' ? snapshot.updatedAt : 0,
    })
  }

  return byId
}

/**
 * 把官方读数折成候选列表。
 *
 * - **筛掉子会话**（含官方标 `subagent` 的、以及带 `parentSession` 的）；
 * - 标题缺失 → `title: null`（客户端显示「(未命名会话)」）；
 * - `updatedAt`：优先用标题快照的更新时间，回落 `header.createdAt`；
 * - 按 `updatedAt` 降序。
 */
export function toCandidatePayload(
  records: readonly SessionRecordLike[],
  titles: readonly TitleObservationLike[],
): readonly SessionCandidatePayload[] {
  const titleById = readTitles(titles)

  const candidates: SessionCandidatePayload[] = []
  for (const record of records) {
    const sessionId = String(record.header.id)
    const kind = classifySession({
      id: sessionId,
      ...(record.header.origin === undefined ? {} : { origin: record.header.origin }),
      ...(record.header.parentSession === undefined
        ? {}
        : { parentSession: record.header.parentSession }),
    })

    if (kind === 'subagent') continue

    const title = titleById.get(sessionId)
    candidates.push({
      sessionId,
      title: title?.title ?? null,
      kind,
      updatedAt: title?.updatedAt ?? record.header.createdAt ?? 0,
    })
  }

  return candidates.sort((left, right) => right.updatedAt - left.updatedAt)
}
