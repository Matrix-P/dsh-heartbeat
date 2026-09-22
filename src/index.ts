/**
 * 心跳插件入口（技术设计 2 章 / 10.2）。
 *
 * 装配顺序：
 *
 * ```
 * settings 命名空间（入口 config 作 base，用户文档覆盖）
 *    │ normalizeHeartbeatConfig（一次性报出全部错误）
 *    ▼
 * 单实例防御（D-10）── block 时拒绝启动调度器
 *    ▼
 * 编排器（配置 + 状态）── 文件存储（每任务一个 JSON，原子写）
 *    ▼
 * 调度器（单 timer，Clock 来自 ctx.timeout）
 * ```
 *
 * 另外订阅两类外部事实：
 * - `api-session/activity` → 用户发言 → FR-5 恢复
 * - `agent/status` → 模型说完 → FR-8 计时基准
 *
 * 【运行时依赖为零】插件只 import `@deepseek-ai/*`（peerDependencies，由 DSH 提供）与
 * Node 内置模块。这不是洁癖：M0 探针证明 `link:` 安装会因官方包副本而分裂模块身份
 * （技术设计第 16 章 R17），去掉运行时依赖后，把包的真实副本放进 profile 即可运行。
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

// 加载官方模块增强（`ctx.settings` / `ctx.timeout` / 事件表）。
// `import type {}` 编译后被完全擦除，不产生运行时依赖。
import type {} from '@deepseek-ai/cordis-plugin-timer'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-settings'

import type { HeartbeatApi } from './api/http.js'
import { createHeartbeatApi } from './api/http.js'
import type { ConfigIssue, NormalizedHeartbeatConfig } from './config.js'
import { normalizeHeartbeatConfig } from './config.js'
import {
  createHostClock,
  createHostDeliveryPort,
  createNodeFileStoreFs,
  createSessionLister,
  prepareHeartbeatStateDir,
  registerHeartbeatRoutes,
} from './host/dsh.js'
import type { TaskFileStore } from './host/file-store.js'
import { createFileTaskStore } from './host/file-store.js'
import { createInstanceLockPort } from './host/instance.js'
import type { Orchestrator, OrchestratorLog, TaskStorePort } from './runtime/orchestrator.js'
import { createOrchestrator } from './runtime/orchestrator.js'
import type { InstanceInfo } from './runtime/store.js'
import { checkSingleInstance, createMemoryTaskStore } from './runtime/store.js'
import { systemTimeZone } from './schedule/zone.js'
import { systemRng } from './templating/render.js'

export const name = 'heartbeat'

/**
 * 只声明 **base 系 profile 恒定提供** 的服务。
 *
 * 【R18】`sessionController` / `webServer` 属于 `dsh-web-app`，**绝不能**写在这里：
 * base / headless profile 上它们永远不会出现，`inject` 会让 fiber 卡在 PENDING。
 * 而直读 `ctx.webServer` 也不行 —— cordis 会抛 `cannot get property … without inject`。
 * 这两个服务走 `ctx.get()` + `ctx.inject()` 延迟接上，见 `host/dsh.ts`。
 */
export const inject = ['agents', 'sessions', 'settings', 'timer']

/** 设置命名空间（必须匹配 `/^[a-z][a-z0-9-]*$/`）。 */
export const NAMESPACE = 'heartbeat'

/**
 * 入口层 config schema。
 *
 * **职责划分**：schemastery 只负责给界面提供全局字段的元数据与默认值；
 * `tasks` 内部结构由 `normalizeHeartbeatConfig` 做深度校验（它能**一次性报出全部
 * 错误并带字段路径**，而 schemastery 的联合类型错误信息做不到）。
 *
 * 入口 config 通过 `settings.register` 的 `base` 选项注入，位于用户文档之下 ——
 * 因此用户在设置界面里的修改总是覆盖它。
 */
export const Config = z.object({
  enabled: z.boolean().default(true).description('组件全局开关'),
  timezone: z.string().default('').description('全局默认时区（留空取系统时区）'),
  coldWake: z
    .union(['session-controller', 'never'])
    .default('session-controller')
    .description('冷会话唤醒策略'),
  singleInstance: z.union(['block', 'warn', 'off']).default('warn').description('多实例防御强度'),
  tasks: z.array(z.any()).default([]).description('定时任务列表（由组件自行深度校验）'),
})

function describeIssues(issues: readonly ConfigIssue[]): string {
  return issues.map((issue) => `${issue.path || '(根)'}：${issue.message}`).join('；')
}

function logEntry(ctx: Context, entry: OrchestratorLog): void {
  const detail = entry.reason === null ? '' : ` reason=${entry.reason}`
  ctx.logger.info(
    'heartbeat: fire task=%s session=%s at=%d outcome=%s result=%s%s',
    entry.taskId,
    entry.session,
    entry.at,
    entry.outcome,
    entry.result ?? '-',
    detail,
  )
}

interface Persistence {
  readonly store: TaskStorePort
  /** 文件存储与实例信息；状态目录不可用时为 `undefined`（降级为纯内存） */
  readonly fileStore: TaskFileStore | undefined
  readonly instance: InstanceInfo | undefined
}

/** 建持久化层；目录不可用就降级成纯内存（**绝不让它拖挂整个插件**）。 */
function createPersistence(ctx: Context, now: number): Persistence {
  try {
    const prepared = prepareHeartbeatStateDir(now)
    const fileStore = createFileTaskStore({
      dir: prepared.dir,
      fs: createNodeFileStoreFs(),
      onError: (taskId, error) => {
        ctx.logger.warn('heartbeat: 运行期状态异常 task=%s err=%s', taskId, String(error))
      },
    })
    return {
      store: fileStore,
      fileStore,
      instance: { pid: prepared.pid, startedAt: prepared.startedAt, host: prepared.host },
    }
  } catch (error) {
    ctx.logger.error(
      'heartbeat: 状态目录不可用，运行期状态将只保存在内存里 —— %s',
      error instanceof Error ? error.message : String(error),
    )
    return { store: createMemoryTaskStore(), fileStore: undefined, instance: undefined }
  }
}

export function apply(ctx: Context, rawConfig: unknown): void {
  const clock = createHostClock(ctx)
  const systemTimezone = systemTimeZone()
  const delivery = createHostDeliveryPort(ctx)
  const persistence = createPersistence(ctx, clock.now())

  let current: NormalizedHeartbeatConfig | null = null
  let warnings: readonly ConfigIssue[] = []

  // 通过函数读取，避免 TS 的控制流分析把 `current` 一直收窄成初始值 `null`
  // （`applyConfig` 在嵌套函数里赋值，静态分析看不到）
  const currentConfig = (): NormalizedHeartbeatConfig | null => current

  const settings = ctx.settings.register(NAMESPACE, Config, {
    // 入口 config 位于用户文档**之下**：用户在设置界面里的修改总是覆盖它
    base: (typeof rawConfig === 'object' && rawConfig !== null ? rawConfig : {}) as never,
    applies: 'live',
    validate: (value: unknown) => {
      const result = normalizeHeartbeatConfig(value, { now: clock.now(), systemTimezone })
      if (!result.ok) {
        throw new TypeError(`心跳配置有 ${result.errors.length} 处问题：${describeIssues(result.errors)}`)
      }
    },
  })

  const orchestrator: Orchestrator = createOrchestrator({
    clock,
    delivery,
    store: persistence.store,
    rng: systemRng(),
    onLog: (entry) => {
      logEntry(ctx, entry)
    },
  })

  const api: HeartbeatApi = createHeartbeatApi({
    snapshot: () => orchestrator.snapshot(),
    knownTaskIds: () => orchestrator.snapshot().map((task) => task.id),
    fire: (taskId) => orchestrator.fireNow(taskId),
    // 界面「目标会话」下拉的数据来源（设计 10.5）；服务不在时返回空列表，界面退化成手填
    sessions: createSessionLister(ctx),
    now: () => clock.now(),
    timezone: systemTimezone,
    globalEnabled: () => currentConfig()?.enabled ?? true,
    warnings: () => warnings,
  })

  // ── 外部事实订阅（fiber 卸载自动注销）────────────────────────────────────
  ctx.effect(
    () =>
      ctx.on('api-session/activity', (sessionId, at) => {
        orchestrator.noteUserActivity(String(sessionId), at)
      }),
    'heartbeat:activity',
  )

  ctx.effect(
    () =>
      ctx.on('agent/status', ({ agent, status }) => {
        if (status !== 'idle') return
        orchestrator.noteAgentIdle(String(agent.id), clock.now())
      }),
    'heartbeat:agent-status',
  )

  // ── 配置应用（含热加载）────────────────────────────────────────────────
  function applyConfig(raw: unknown): void {
    const result = normalizeHeartbeatConfig(raw, { now: clock.now(), systemTimezone })
    if (!result.ok) {
      // 需求 8.6：错误一次性全部报出；此时保持上一次生效的配置，不半途改坏
      ctx.logger.error(
        'heartbeat: 配置有 %d 处问题，已保留上一次生效的配置 —— %s',
        result.errors.length,
        describeIssues(result.errors),
      )
      return
    }

    current = result.config
    warnings = result.warnings
    for (const issue of result.warnings) {
      ctx.logger.warn('heartbeat: 配置提示 %s —— %s', issue.path, issue.message)
    }
    orchestrator.applyConfig(result.config)
  }

  applyConfig(settings.get())
  ctx.effect(
    () =>
      settings.watch((next) => {
        applyConfig(next)
      }),
    'heartbeat:settings-watch',
  )

  // ── 单实例防御（D-10）──────────────────────────────────────────────────
  const { fileStore, instance } = persistence

  if (fileStore !== undefined && instance !== undefined) {
    const lock = createInstanceLockPort({
      read: () => fileStore.readInstance(),
      write: (info) => fileStore.writeInstance(info),
    })

    const verdict = checkSingleInstance(currentConfig()?.singleInstance ?? 'warn', instance, lock)

    if (verdict.kind === 'warn') ctx.logger.warn('heartbeat: %s', verdict.message)

    if (verdict.kind === 'blocked') {
      ctx.logger.error('heartbeat: %s', verdict.message)
      // 拒绝启动调度器，但保留状态查询接口 —— 用户还能在界面上看到发生了什么
      registerHeartbeatRoutes(ctx, api)
      return
    }

    lock.write(instance)
  }

  // 路由的生命周期由 registerHeartbeatRoutes 自己管（挂在注册它的 fiber 上）
  registerHeartbeatRoutes(ctx, api)

  orchestrator.start()
  ctx.effect(
    () => () => {
      orchestrator.stop()
    },
    'heartbeat:stop',
  )

  ctx.logger.info(
    'heartbeat: 已启动 tasks=%d timezone=%s coldWake=%s stateDir=%s',
    currentConfig()?.tasks.length ?? 0,
    currentConfig()?.timezone ?? systemTimezone,
    currentConfig()?.coldWake ?? 'session-controller',
    fileStore === undefined ? '(内存)' : 'storages/heartbeat',
  )
}
