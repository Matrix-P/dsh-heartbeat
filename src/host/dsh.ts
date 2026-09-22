/**
 * DSH host 胶水层 —— **唯一**直接接触 `@deepseek-ai/*` 的地方。
 *
 * 这一层的职责只有一件事：把 DSH 的 `ctx` 服务翻译成 `host/ports.ts` 里定义的
 * 能力函数。逻辑本身都在可单测的模块里，这里只做映射。
 *
 * 它原本没有配套单测（靠类型检查 + M0 探针兜底），直到 R18 打脸：**「按可选处理」的
 * 直读写法在 cordis 4 里会抛异常**，而这个 bug 只在真 `ctx` 上才暴露。
 * 现在 `test/host/dsh.test.ts` 用真的 cordis context 跑这一层。
 */

import { hostname } from 'node:os'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'

// 下面这些 import 只为**加载官方包的 `declare module '@deepseek-ai/cordis'` 增强**，
// 让 `ctx.timeout` / `ctx.sessionController` / `ctx.webServer` 进入类型系统。
// `import type {}` 在编译后会被完全擦除，不会产生任何运行时依赖。
import type {} from '@deepseek-ai/cordis-plugin-timer'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-settings'

import type { HeartbeatApi } from '../api/http.js'
import { API_PATHS } from '../api/http.js'
import { createNodeHttpHandler } from '../api/node-http.js'
import type { DeliveryPort } from '../delivery/deliver.js'
import type { Clock } from '../runtime/clock.js'
import type { TaskFileStoreFs } from './file-store.js'
import { TASKS_DIR } from './file-store.js'
import type { AgentCapabilities, AgentLike } from './ports.js'
import { createClockAdapter, createDeliveryPort, toUserMessage } from './ports.js'
import type { SessionCandidatePayload, SessionRecordLike, TitleObservationLike } from './sessions.js'
import { toCandidatePayload } from './sessions.js'

/** 把官方 `Agent` 收敛成本组件的 `AgentLike`。 */
function toAgentLike(agent: Agent): AgentLike {
  const header = agent.session.header
  return {
    id: String(agent.id),
    status: agent.status,
    session: {
      header: {
        ...(header.origin === undefined ? {} : { origin: header.origin }),
        ...(header.parentSession === undefined
          ? {}
          : { parentSession: String(header.parentSession) }),
      },
    },
  }
}

/** 用 host 的定时器服务（随插件 fiber 自动清理）实现时钟。 */
export function createHostClock(ctx: Context): Clock {
  return createClockAdapter({
    now: () => Date.now(),
    timeout: (callback, delay) => ctx.timeout(callback, delay),
  })
}

/**
 * 组装投递端口。
 *
 * `sessionController` **按可选处理**：它属于 `dsh-web-app`，只在 Web 系 profile 存在
 * （base profile 没有）。拿不到时就不提供 `warmUp`，编排器会把冷会话判为
 * `skipped`（保持逾期等待上线），而**不是**误判成 ERROR。
 *
 * 【R18 —— 这里踩过坑，别再改回去】cordis 4 里读一个自己没有 `inject` 的服务会**抛错**
 * （`cannot get property "sessionController" without inject`），**不是**返回 undefined。
 * 于是下面两条路都不能走：
 *
 * - 直读 `ctx.sessionController` → `apply` 直接抛异常，插件整个起不来；
 * - 把它写进 `inject` → base / headless profile 永远等不到这个服务，fiber 卡 PENDING。
 *
 * 唯一正确的写法是官方的 `ctx.get()` + `ctx.inject(deps, cb)`：先看现在有没有
 * （拿不到只会是 `undefined`，不抛），没有就交给 cordis 在服务出现后回调补上。
 * 实测两条性质都成立：服务永不出现时父插件照常 `apply` 完、不被拖挂；
 * 服务稍后出现时回调会被触发。
 */
export function createHostDeliveryPort(ctx: Context): DeliveryPort {
  const agents = ctx.agents

  const live = (sessionId: string): Agent | undefined => agents.get(sessionId as SessionId)

  const capabilities: AgentCapabilities = {
    getAgent: (sessionId) => {
      const agent = live(sessionId)
      return agent === undefined ? undefined : toAgentLike(agent)
    },

    rootAgents: () => agents.roots().map(toAgentLike),

    isOwnedBy: (sessionId, owner) => {
      const agent = live(sessionId)
      const ownerAgent = live(owner.id)
      if (agent === undefined || ownerAgent === undefined) return false
      return agents.isOwnedBy(agent.id, ownerAgent)
    },

    followup: (sessionId, message) => {
      const agent = live(sessionId)
      if (agent === undefined) throw new Error(`会话 ${sessionId} 当前没有 live 的 Agent`)
      agent.followup(toUserMessage(message))
    },

    inject: (sessionId, message) => {
      const agent = live(sessionId)
      if (agent === undefined) throw new Error(`会话 ${sessionId} 当前没有 live 的 Agent`)
      agent.inject(toUserMessage(message))
    },
  }

  // 能力是**动态补上**的；`createDeliveryPort` 用 getter 按调用时读取它
  const attachColdWake = (scope: Context): void => {
    const controller = scope.get('sessionController') as Context['sessionController'] | undefined
    if (controller === undefined) return
    capabilities.resolveAgent = async (sessionId) => {
      await controller.resolveAgent(sessionId as SessionId)
    }
  }

  if (ctx.get('sessionController') === undefined) ctx.inject(['sessionController'], attachColdWake)
  else attachColdWake(ctx)

  return createDeliveryPort(capabilities)
}

/** 官方 `ctx.sessionQuery` 的结构子集（`dsh-session-query lib/types/index.d.ts:67,105`）。 */
interface SessionQueryLike {
  listSessions(signal?: AbortSignal): Promise<readonly SessionRecordLike[]>
  readTitleSnapshots(
    sessionIds: readonly unknown[],
    signal?: AbortSignal,
  ): Promise<readonly TitleObservationLike[]>
}

/**
 * 会话候选读取器（设计 10.5）。
 *
 * 【R18】`sessionQuery` 不是 base 系恒定提供的服务，所以既不能直读、也不写进 `inject`。
 * 不过这里连 `ctx.inject` 的延迟都不需要：这个闭包只在**收到 HTTP 请求时**才执行，
 * 那时所有插件早就加载完了，`ctx.get()` 读到的就是当下的事实。
 *
 * `sessionQuery` 用**结构化接口**声明而不是引官方类型：它只是一个可选的读数来源，
 * 引进来会平白多一个 peer 依赖。字段形状对着官方 `lib/types` 抄，越界字段一律
 * `unknown` 后自己收敛。
 */
export function createSessionLister(
  ctx: Context,
): () => Promise<readonly SessionCandidatePayload[]> {
  return async () => {
    const query = ctx.get('sessionQuery') as SessionQueryLike | undefined
    if (query === undefined) return []

    const records = await query.listSessions()
    const ids = records.map((record) => record.header.id)

    // 标题是**锦上添花**：读不到就整列回落 null（界面显示「(未命名会话)」），
    // 绝不能因为标题读失败就把整个候选列表丢掉
    let titles: readonly TitleObservationLike[] = []
    try {
      titles = await query.readTitleSnapshots(ids)
    } catch {
      titles = []
    }

    return toCandidatePayload(records, titles)
  }
}

/**
 * 把心跳的 HTTP 接口挂到 host 的 web server 上。
 *
 * 【路由表只有一个来源】这里**必须遍历 {@link API_PATHS}**，不能手写路径清单：
 * 曾经在 `api/http.ts` 里加了 `SESSIONS_PATH` 的分支却忘了在这里注册，
 * 而未注册的 `/api/*` 会被 DSH 的统一鉴权门接管 → 客户端只拿到 401 →
 * 会话下拉永远退回"手填"，而 host 侧日志一切正常（最难查的那种）。
 *
 * 生命周期自己管：路由随**注册它的那个 fiber** 一起反注册，调用方不需要接返回值
 * （与官方 `dsh-client-modules` 注册 `/plugins` 路由的写法一致）。
 * R18 的同一个坑在这里也适用 —— 见 {@link createHostDeliveryPort} 的说明。
 */
export function registerHeartbeatRoutes(ctx: Context, api: HeartbeatApi): void {
  const mount = (scope: Context): void => {
    const webServer = scope.get('webServer') as Context['webServer'] | undefined
    if (webServer === undefined) return

    const handler = createNodeHttpHandler(api)
    scope.effect(() => {
      const disposers = API_PATHS.map((path) => webServer.register({ kind: 'exact', path, handler }))
      return () => {
        for (const dispose of disposers) dispose()
      }
    }, 'heartbeat:http-routes')
  }

  if (ctx.get('webServer') === undefined) ctx.inject(['webServer'], mount)
  else mount(ctx)
}

/** 心跳运行期状态的目录：`$DSH_HOME/storages/heartbeat`（按记录落盘）。 */
export function heartbeatStateDir(): string {
  return dshHomePath('storages', 'heartbeat')
}

/**
 * 原子写：先写同目录临时文件，再 `rename` 覆盖。
 *
 * 同目录 rename 在同一文件系统上是原子的，读者只会看到旧内容或新内容，不会读到半截。
 * 官方有 `@deepseek-ai/dsh-atomic-write` 做同样的事（还额外处理 Windows 的
 * EACCES/EBUSY 重试），但那是一个额外的 peer 依赖；这里用十行自实现把依赖面降下来。
 */
async function writeFileAtomic(path: string, content: string): Promise<void> {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID().slice(0, 8)}.tmp`

  try {
    writeFileSync(temporary, content, { mode: 0o600 })
    renameSync(temporary, path)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
}

/** 真实文件系统实现：原子写 + 目录自动创建。 */
export function createNodeFileStoreFs(): TaskFileStoreFs {
  return {
    read(path) {
      try {
        return readFileSync(path, 'utf8')
      } catch {
        // 文件不存在是最常见的正常情况（首次启动）
        return undefined
      }
    },

    write: (path, content) => writeFileAtomic(path, content),

    async remove(path) {
      rmSync(path, { force: true })
    },
  }
}

export interface HeartbeatStateDirInfo {
  readonly dir: string
  readonly pid: number
  readonly startedAt: number
  readonly host: string
}

/** 建好目录并给出当前实例信息（单实例防御用）。 */
export function prepareHeartbeatStateDir(now: number): HeartbeatStateDirInfo {
  const dir = heartbeatStateDir()
  mkdirSync(`${dir}/${TASKS_DIR}`, { recursive: true })
  return { dir, pid: process.pid, startedAt: now, host: hostname() }
}
