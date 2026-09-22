/**
 * 会话分类（需求 12.5 / 技术设计 10.5）。
 *
 * 放在**中立模块**里，因为服务端与客户端必须用同一份判定：
 * 服务端据此筛候选，客户端据此打标签 —— 两份规则一旦漂移，
 * 界面上标着"根会话"的东西可能实际上是子会话，那就违背 FR-4 第 2 条了。
 */

export type SessionKind = 'root' | 'subagent' | 'plugin-channel'

/** 分类只需要 header 的三个字段（官方 `SessionHeader` 的结构子集）。 */
export interface SessionHeaderLike {
  readonly id: string
  /** 官方唯一取值 `'subagent'`。 */
  readonly origin?: string
  /** 官方为品牌化的 `SessionId`；这里只关心"有没有"。 */
  readonly parentSession?: unknown
}

/** IM 插件给会话 id 加的前缀（`@michengai/dsh-im-connect` 的约定，**不是官方字段**）。 */
export const IM_SESSION_PREFIX = 'im:'

/**
 * 分类规则（设计文档 10.5 逐条落地）：
 *
 * - `origin === 'subagent'` 或带 `parentSession` → `subagent`，**绝不可投递**（FR-4 第 2 条）；
 * - id 以 `im:` 开头 → `plugin-channel`，IM 会话本质上仍是根会话，可选，界面打标签提示；
 * - 其余 → `root`。
 *
 * `im:` 前缀只用于**显示分类**，不作为任何安全判定：真正的投递合法性由 host 侧
 * 「只给主 Agent」那条约束把关（`delivery/deliver.ts`）。
 */
export function classifySession(header: SessionHeaderLike): SessionKind {
  if (header.origin === 'subagent' || header.parentSession !== undefined) return 'subagent'
  if (header.id.startsWith(IM_SESSION_PREFIX)) return 'plugin-channel'
  return 'root'
}
