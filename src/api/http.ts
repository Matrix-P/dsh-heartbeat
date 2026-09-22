/**
 * 心跳的 HTTP 状态接口（技术设计 10.2 / 11.3）。
 *
 * 为什么需要它：**运行期状态不能写进 `settings.yaml`**。那是用户手写的配置文档，
 * 往里写 `nextFireAt` / `fireCount` 会把文档搞脏、并疯狂触发 `settings/document-updated`。
 * 所以配置走 `ctx.settings`，运行期状态走这条只读 HTTP 通道。
 *
 * 本模块**不认识任何 HTTP 框架**：入口是一个纯函数 `handle(request)`，
 * 由 host 适配层把它接到 `ctx.webServer.register` 上。因此可以完全离线测试。
 */

import type { ConfigIssue } from '../config.js'
import type { SessionCandidatePayload } from '../host/sessions.js'
import type { TaskSnapshot } from '../runtime/orchestrator.js'

export const STATE_PATH = '/api/heartbeat/state'
export const FIRE_PATH = '/api/heartbeat/fire'
/**
 * 会话候选列表（界面「目标会话」下拉的数据来源，设计 10.5）。
 *
 * 为什么也走这条通道：设计指定的数据源 `ctx.sessionQuery` 是**服务端**能力，
 * 浏览器里没有；而它又是纯读取，和 state 一样不需要 `fromLoopback` 限制。
 */
export const SESSIONS_PATH = '/api/heartbeat/sessions'

/**
 * **所有**端点的唯一来源。
 *
 * host 侧按这张表注册路由（`host/dsh.ts` 遍历它），测试也按它断言 —— 于是
 * "加了 handler 却忘了注册"这一类 bug 就不可能再发生。这个坑真踩过：
 * `SESSIONS_PATH` 只加在下面的 `handle()` 分支里，没加进 host 的注册清单，
 * 而未注册的 `/api/*` 会被 DSH 的统一鉴权门接管返回 **401**，客户端
 * `!response.ok` 后静默退回"手填会话 id"，host 侧日志一点异常都没有。
 */
export const API_PATHS = [STATE_PATH, SESSIONS_PATH, FIRE_PATH] as const

export interface HttpRequestLike {
  readonly method: string
  /** 不含 query string 的路径 */
  readonly path: string
  readonly query: ReadonlyMap<string, string>
  /** 原始请求体；GET 时为 undefined */
  readonly body?: string
  /**
   * 是否来自本机。**必须逐请求判定**：DSH 的 web server 既可能绑 `127.0.0.1`
   * 也可能绑 `0.0.0.0`（`dsh-host-webserver` 的 `Config.host`），所以"是不是本机"
   * 是请求的属性，不是服务的属性。与 DSH 设置面的约定一致：非 loopback 只读。
   */
  readonly fromLoopback: boolean
}

export interface HttpResponseLike {
  readonly status: number
  readonly contentType: string
  readonly body: string
}

export interface HeartbeatApiDeps {
  readonly snapshot: () => readonly TaskSnapshot[]
  readonly knownTaskIds: () => readonly string[]
  readonly fire: (taskId: string) => Promise<void>
  /** 会话候选（已在 host 侧筛掉子会话并按最近活跃排序） */
  readonly sessions: () => Promise<readonly SessionCandidatePayload[]>
  readonly now: () => number
  readonly timezone: string
  readonly globalEnabled: () => boolean
  /** 配置加载期产生的提示（例如 `once` 已过期） */
  readonly warnings: () => readonly ConfigIssue[]
}

export interface HeartbeatApi {
  handle(request: HttpRequestLike): Promise<HttpResponseLike>
}

const JSON_TYPE = 'application/json; charset=utf-8'

function json(status: number, payload: unknown): HttpResponseLike {
  return { status, contentType: JSON_TYPE, body: JSON.stringify(payload) }
}

function text(status: number, body: string): HttpResponseLike {
  return { status, contentType: 'text/plain; charset=utf-8', body }
}

export function createHeartbeatApi(deps: HeartbeatApiDeps): HeartbeatApi {
  async function handleState(): Promise<HttpResponseLike> {
    return json(200, {
      now: deps.now(),
      timezone: deps.timezone,
      globalEnabled: deps.globalEnabled(),
      warnings: deps.warnings(),
      tasks: deps.snapshot(),
    })
  }

  /**
   * 会话候选。**失败也返回 200 + 空列表**：候选取不到不该让设置界面报错，
   * 客户端会自动退化成"手填会话 id"（`section.tsx` 的 `sessions.length === 0` 分支）。
   */
  async function handleSessions(): Promise<HttpResponseLike> {
    try {
      return json(200, { candidates: await deps.sessions() })
    } catch (error) {
      return json(200, {
        candidates: [],
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  async function handleFire(request: HttpRequestLike): Promise<HttpResponseLike> {
    if (!request.fromLoopback) {
      return text(403, '心跳的手动触发只允许从本机发起')
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(request.body ?? '')
    } catch {
      return text(400, '请求体不是合法 JSON')
    }

    const taskId =
      typeof parsed === 'object' && parsed !== null
        ? (parsed as { id?: unknown }).id
        : undefined

    if (typeof taskId !== 'string' || taskId === '') {
      return text(400, '请求体必须是 {"id": "<taskId>"}')
    }

    if (!deps.knownTaskIds().includes(taskId)) {
      return text(404, `未知任务 id：${taskId}`)
    }

    try {
      await deps.fire(taskId)
    } catch (error) {
      return text(500, `触发失败：${error instanceof Error ? error.message : String(error)}`)
    }

    return json(200, { ok: true, id: taskId })
  }

  return {
    async handle(request) {
      if (request.path === STATE_PATH) {
        if (request.method !== 'GET') return text(405, '该路径只接受 GET')
        return handleState()
      }

      if (request.path === SESSIONS_PATH) {
        if (request.method !== 'GET') return text(405, '该路径只接受 GET')
        return handleSessions()
      }

      if (request.path === FIRE_PATH) {
        if (request.method !== 'POST') return text(405, '该路径只接受 POST')
        return handleFire(request)
      }

      return text(404, '未知路径')
    },
  }
}
