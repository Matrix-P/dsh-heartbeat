/**
 * 配置通道适配层 —— 让同一份代码同时跑在 DSH **0.1.x** 与 **0.2.x** 上。
 *
 * 背景（实测）：0.2.0 把配置系统重新设计了。官方类型里
 * `SettingsForms` **没有 `register`**，配置改为「读 Loader 行自己的 Config」，
 * 读写走 `describe()/update(ns)/replace/mutate`，`ns` 是**行 id**而不是自由命名的
 * 命名空间；`settings.yaml` 的那套命名空间已作为遗留文档导入 profile。
 *
 * 于是这里用**运行时探测**取代硬编码版本判断：
 *
 * | 探测结果 | 走哪条路 | 配置从哪来 |
 * | --- | --- | --- |
 * | `settings.register` 是函数（0.1.x） | 注册命名空间 + `watch` 热更新 | 命名空间文档（用户文档覆盖入口 config） |
 * | 没有 `register`（0.2.x） | 不注册 | `apply(ctx, config)` 收到的那份 Loader 行 Config |
 *
 * 【为什么用结构化接口而不是引官方类型】官方类型在两代之间是**互斥**的
 * （0.1.x 的 `Settings` 有 `register`，0.2.x 的 `SettingsForms` 没有），
 * 引任何一代都会让另一代编译不过。这里只声明我们真正用到的结构，
 * 与 `host/dsh.ts` 里 `sessionQuery` 的做法一致。
 *
 * 0.2.x 侧**没有** `validate` 钩子（官方只在 0.1.x 提供），所以校验改为
 * 「运行期校验 + 把问题通过 `/api/heartbeat/state` 的 `warnings` 暴露给界面」，
 * 见 `src/index.ts` 的 `applyConfig`。
 */

/** 0.1.x `settings.register` 的选项（我们用到的那几个字段）。 */
export interface LegacyRegisterOptions {
  /** 位于用户文档**之下**的入口 config。 */
  base?: unknown
  applies?: 'live'
  /** 保存前校验；抛错即拒绝写入。0.2.x 没有这个钩子。 */
  validate?: (value: unknown) => void
}

/** 0.1.x 命名空间作用域的最小结构。 */
export interface LegacySettingsScope {
  get(): unknown
  watch(listener: (next: unknown) => void): () => void
}

/** 0.1.x settings 服务里我们用到的那一个方法。 */
export interface LegacySettingsService {
  register(
    namespace: string,
    schema: unknown,
    options: LegacyRegisterOptions,
  ): LegacySettingsScope
}

/** 只需要能按名字取服务：`ctx.get` 是官方认可的"服务可能不存在"的读法（见 R18）。 */
export interface ServiceLookup {
  get(name: string): unknown
}

export interface ConfigChannelOptions {
  readonly namespace: string
  /** 交给 0.1.x `register` 的 schema（0.2.x 由 Loader 行自己的 Config 提供，用不到）。 */
  readonly schema: unknown
  /** `apply(ctx, config)` 收到的那份配置 —— 0.2.x 的唯一来源。 */
  readonly rawConfig: unknown
  /** 仅 0.1.x 生效的写前校验。 */
  readonly validate: (value: unknown) => void
}

export interface ConfigChannel {
  /** 起始配置值。 */
  readonly initial: unknown
  /** 订阅后续变更；0.2.x 下是不订阅的 no-op（配置变更会重新 apply 本插件）。 */
  subscribe(listener: (next: unknown) => void): () => void
  /** `true` = 走了 0.1.x 的注册路径；`false` = 0.2.x 的 Loader 行路径。 */
  readonly registered: boolean
}

/** 探测成功时返回 0.1.x 的 settings 服务，否则 `undefined`。 */
export function resolveLegacySettings(lookup: ServiceLookup): LegacySettingsService | undefined {
  const candidate = lookup.get('settings') as Partial<LegacySettingsService> | undefined
  if (candidate === undefined || candidate === null) return undefined
  return typeof candidate.register === 'function' ? (candidate as LegacySettingsService) : undefined
}

/**
 * 打开配置通道：0.1.x 注册命名空间并接上热更新；0.2.x 直接用 Loader 行的 config。
 */
export function openConfigChannel(
  lookup: ServiceLookup,
  options: ConfigChannelOptions,
): ConfigChannel {
  const legacy = resolveLegacySettings(lookup)

  if (legacy !== undefined) {
    const scope = legacy.register(options.namespace, options.schema, {
      // 与改造前一致：非对象一律退化成空对象，交给 schema 的默认值兜底
      base:
        typeof options.rawConfig === 'object' && options.rawConfig !== null
          ? options.rawConfig
          : {},
      applies: 'live',
      validate: options.validate,
    })
    return {
      initial: scope.get(),
      subscribe: (listener) => scope.watch(listener),
      registered: true,
    }
  }

  return {
    initial: options.rawConfig,
    // 0.2.x 里配置是 Loader 行的属性：改了它，加载器会带着新 config 重新挂载本插件，
    // 因此这里不需要（也没有）热更新订阅。
    subscribe: () => () => undefined,
    registered: false,
  }
}
