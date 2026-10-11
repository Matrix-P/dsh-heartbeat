/**
 * 客户端配置通道适配层 —— 两代自适应（与 `host/settings-port.ts` 对称）。
 *
 * 【为什么需要它】0.2.0 把配置系统重做了，**客户端服务 `settingsScope` 被移除**
 * （实测：0.2.0 的 `dsh-client-ui-settings` 里 `settingsScope` **0 处命中**）。
 * 0.2.0 的替代品是 `ctx.configForms`：
 *
 * | | 0.1.x | 0.2.x |
 * | --- | --- | --- |
 * | 服务 | `ctx.settingsScope` | `ctx.configForms` |
 * | 读 | `bind({namespace}).getSnapshot()` | `describe()` → 按**行 id** 找描述符 |
 * | 写 | `scope.set(field, value)` | `update(ns, patch, revision)` |
 * | 配置存放 | 命名空间文档 | **Loader 行自己的 config** |
 *
 * UI 挂载点没变（`settings.section` 插槽两代都在，实测确认），所以这里只换**数据通道**，
 * 对 `HeartbeatSection` 暴露同一个 `SettingsScopeLike` 接口 —— 组件一行都不用改。
 *
 * 【绝不把这两代独有的服务写进 `inject`】那是这轮最贵的教训：
 * `inject: ['slots','locale','settingsScope']` 在 0.2.x 上会让 fiber 永远
 * `pending (waiting for service: settingsScope)`，把整个 web 启动判为失败（桌面端打不开）。
 * 所以 `inject` 只留两代都有的服务，这里全部用 `ctx.get()` 探测。
 */

import type { SettingsScopeLike, SettingsScopeSnapshot } from './section.js'

/** 只需要"按名字取服务"：`ctx.get` 是官方认可的安全读法（服务不存在时返回 undefined）。 */
export interface ServiceLookup {
  get(name: string): unknown
}

/** 0.1.x 的客户端 settings 服务。 */
export interface LegacyScopeService {
  bind(spec: { readonly namespace: string }): unknown
}

/** 0.2.x 的一个配置表单描述符（服务端 `SettingsDescriptor` 的客户端镜像）。 */
export interface ConfigFormDescriptor {
  /** **Loader 行 id**（不是自由命名的命名空间）。 */
  readonly ns: string
  readonly value?: unknown
  readonly revision?: number
  readonly writable?: boolean
}

/** 0.2.x 的客户端配置表单服务。 */
export interface ConfigFormsService {
  describe(): readonly ConfigFormDescriptor[]
  update(ns: string, patch: object, expectedRevision?: number): Promise<void>
}

export interface ClientConfigPortOptions {
  /** 0.1.x 用：设置命名空间。 */
  readonly namespace: string
  /** 0.2.x 用：本插件那条 Loader 行的 id（等于 `cordis.patch.yml` 里的 `id`）。 */
  readonly entryId: string
}

function isLegacyScopeService(value: unknown): value is LegacyScopeService {
  return typeof (value as LegacyScopeService | undefined)?.bind === 'function'
}

function isConfigFormsService(value: unknown): value is ConfigFormsService {
  const candidate = value as ConfigFormsService | undefined
  return (
    typeof candidate?.describe === 'function' && typeof candidate?.update === 'function'
  )
}

/**
 * 把 0.2.x 的 `configForms` 包装成 0.1.x 形状的 `SettingsScopeLike`。
 *
 * 【订阅】0.2.x 没有给分区推送配置变更的通道，所以 `subscribe` 是 no-op；
 * 界面靠既有的 5 秒状态轮询触发重渲染，`getSnapshot()` 每次重新 `describe()`
 * 都能读到最新值 —— 写入后最迟 5 秒可见。
 */
function configFormsScope(forms: ConfigFormsService, entryId: string): SettingsScopeLike {
  const find = (): ConfigFormDescriptor | undefined =>
    forms.describe().find((descriptor) => descriptor.ns === entryId)

  return {
    getSnapshot(): SettingsScopeSnapshot {
      const descriptor = find()
      if (descriptor === undefined) return { status: 'unavailable' }

      const value =
        typeof descriptor.value === 'object' && descriptor.value !== null
          ? (descriptor.value as { enabled?: boolean; tasks?: readonly unknown[] })
          : {}

      return { status: 'ready', value, writable: descriptor.writable !== false }
    },

    subscribe() {
      return () => undefined
    },

    async set(field: string, value: unknown): Promise<void> {
      const descriptor = find()
      await forms.update(entryId, { [field]: value }, descriptor?.revision)
    },
  }
}

/**
 * 打开客户端配置通道。两条路都探测不到时返回 `undefined` —— 调用方应**跳过自定义分区**
 * （0.2.x 上配置交给官方由 schema 自动生成的表单），而不是让插件卡住。
 */
export function openClientConfigPort(
  lookup: ServiceLookup,
  options: ClientConfigPortOptions,
): SettingsScopeLike | undefined {
  const legacy = lookup.get('settingsScope')
  if (isLegacyScopeService(legacy)) {
    return legacy.bind({ namespace: options.namespace }) as SettingsScopeLike
  }

  const forms = lookup.get('configForms')
  if (isConfigFormsService(forms)) {
    return configFormsScope(forms, options.entryId)
  }

  return undefined
}

/** 配置读写端点（与 `src/api/http.ts` 的 `CONFIG_PATH` 同值，故意各写一份）。 */
export const HTTP_CONFIG_PATH = '/api/heartbeat/config'

/**
 * HTTP 兜底作用域 —— **两代都不依赖任何客户端服务**。
 *
 * 【为什么必须有它】实测（`clientPings: 1`）证明客户端半边能跑，但 0.2.x 上
 * `settingsScope` 不存在、`configForms` 又探测不到 → 之前"探测失败就跳过分区"
 * 会让界面整个消失 ✗✗ 所以改成兜底：配置读写走我们自己的 HTTP 端点。
 *
 * 【同步接口怎么接异步 IO】`SettingsScopeLike.getSnapshot()` 是**同步**的，
 * 所以这里维护一份缓存：创建时拉一次、`subscribe()` 时再拉一次、`set()` 写完再拉。
 * 界面本来就有 5 秒状态轮询会触发重渲染，所以最迟 5 秒可见最新值 ✓
 */
export function createHttpConfigPort(
  fetchImpl: typeof fetch,
  path: string = HTTP_CONFIG_PATH,
): SettingsScopeLike {
  let snapshot: SettingsScopeSnapshot = { status: 'unavailable' }
  const listeners = new Set<(next: SettingsScopeSnapshot) => void>()

  const publish = (next: SettingsScopeSnapshot): void => {
    snapshot = next
    for (const listener of [...listeners]) listener(next)
  }

  const refresh = async (): Promise<void> => {
    try {
      const response = await fetchImpl(path, { headers: { accept: 'application/json' } })
      if (!response.ok) {
        publish({ status: 'unavailable' })
        return
      }
      const payload = (await response.json()) as { tasks?: readonly unknown[] }
      publish({
        status: 'ready',
        value: { tasks: Array.isArray(payload.tasks) ? payload.tasks : [] },
        writable: true,
      })
    } catch {
      // 拿不到就标不可用 —— 绝不抛：抛了会让整个设置分区渲染失败
      publish({ status: 'unavailable' })
    }
  }

  void refresh()

  return {
    getSnapshot: () => snapshot,

    subscribe(listener: (next: SettingsScopeSnapshot) => void) {
      listeners.add(listener)
      void refresh()
      return () => {
        listeners.delete(listener)
      }
    },

    async set(field: string, value: unknown): Promise<void> {
      await fetchImpl(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ [field]: value }),
      })
      await refresh()
    },
  }
}
