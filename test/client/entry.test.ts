import { describe, expect, it } from 'vitest'

import type { ClientContext } from '../../src/client/index.js'
import { apply, inject, LOCALE_NS, name } from '../../src/client/index.js'

interface RegisteredSection {
  readonly options: Record<string, unknown>
  readonly component: unknown
}

interface World {
  ctx: ClientContext
  readonly localeDictionaries: Array<{ namespace: string; dictionaries: unknown }>
  readonly settingsScopeNamespaces: string[]
  readonly effects: string[]
  slotInjections: Array<{ key: string; fired: boolean }>
  sections: RegisteredSection[]
}

function createWorld(): World {
  const world: World = {
    localeDictionaries: [],
    settingsScopeNamespaces: [],
    effects: [],
    slotInjections: [],
    sections: [],
    ctx: undefined as unknown as ClientContext,
  }

  const ctx: ClientContext = {
    slots: {
      inject(key, callback) {
        const entry = { key, fired: false }
        world.slotInjections.push(entry)
        // 真实实现里回调会在「插槽被声明之后」才执行；测试里立即执行以观察注册内容
        callback()
        entry.fired = true
        return () => undefined
      },
      register(options, component) {
        world.sections.push({
          options: options as unknown as Record<string, unknown>,
          component,
        })
        return () => undefined
      },
    },

    locale: {
      register(namespaceName, dictionaries) {
        world.localeDictionaries.push({ namespace: namespaceName, dictionaries })
        return () => undefined
      },
      bind() {
        return (key: string) => `t:${key}`
      },
    },

    settingsScope: {
      bind(spec) {
        world.settingsScopeNamespaces.push(spec.namespace)
        return { namespace: spec.namespace }
      },
    },

    // 0.1.x 有 settingsScope；0.2.x 没有 —— 插件必须用 ctx.get() 可选读取。
    // 这里返回它，走的正是「0.1.x：注册自定义分区」那条路。
    get(name) {
      return name === 'settingsScope' ? ctx.settingsScope : undefined
    },

    effect(callback, label) {
      world.effects.push(label ?? '(no-label)')
      return callback()
    },
  }

  world.ctx = ctx
  return world
}

describe('client 入口 — 插件形态', () => {
  it('导出名字与依赖声明', () => {
    expect(name).toBe('heartbeat-client')
    expect(inject).toContain('slots')
    expect(inject).toContain('locale')
    // 【重要】settingsScope 是 0.1.x 的客户端服务；0.2.x 没有它。
    // 写进 inject 会让 fiber 永远 pending（waiting for service: settingsScope），
    // 进而把整个 web 启动判为失败 —— 桌面端直接打不开（实测崩溃日志）。
    expect(inject).not.toContain('settingsScope')
  })

  it('词表注册包在 ctx.effect 里（fiber 卸载自动清理）', () => {
    const world = createWorld()
    apply(world.ctx)

    // 词表一条。`slots.inject` 的控制器与 `settingsScope.bind` 本来就归属调用方 fiber
    // （官方文档：the controller belongs to the caller's fiber），不必再套一层 effect
    expect(world.effects.length).toBeGreaterThanOrEqual(1)
    for (const label of world.effects) expect(label).toContain('heartbeat')
  })
})

describe('client 入口 — 词表', () => {
  it('注册中英双语字典', () => {
    const world = createWorld()
    apply(world.ctx)

    expect(world.localeDictionaries).toHaveLength(1)
    const entry = world.localeDictionaries[0]
    expect(entry?.namespace).toBe(LOCALE_NS)

    const dictionaries = entry?.dictionaries as Record<string, Record<string, string>>
    expect(Object.keys(dictionaries).sort()).toEqual(['en', 'zh'])
  })

  it('中英字典的 key 集合一致（不漏翻）', () => {
    const world = createWorld()
    apply(world.ctx)

    const dictionaries = world.localeDictionaries[0]?.dictionaries as Record<
      string,
      Record<string, string>
    >
    expect(Object.keys(dictionaries.zh ?? {}).sort()).toEqual(Object.keys(dictionaries.en ?? {}).sort())
  })

  it('关键文案都存在', () => {
    const world = createWorld()
    apply(world.ctx)

    const zh = (world.localeDictionaries[0]?.dictionaries as Record<string, Record<string, string>>)
      .zh as Record<string, string>
    for (const key of ['nav', 'empty', 'addTask', 'enabled', 'taskId', 'payloadText', 'session']) {
      expect(zh[key], `缺少文案 ${key}`).toBeTruthy()
    }
  })
})

describe('client 入口 — 设置分区注册', () => {
  it('通过 slots.inject 注册（直接 register 会因插槽未声明而抛错）', () => {
    const world = createWorld()
    apply(world.ctx)

    expect(world.slotInjections).toHaveLength(1)
    expect(world.slotInjections[0]?.key).toBe('settings.section')
    expect(world.slotInjections[0]?.fired).toBe(true)
  })

  it('注册项带上必须的字段', () => {
    const world = createWorld()
    apply(world.ctx)

    expect(world.sections).toHaveLength(1)
    const options = world.sections[0]?.options
    expect(options?.name).toBe('settings.section')
    expect(options?.id).toBe('heartbeat')
    expect(typeof options?.order).toBe('number')
    expect(typeof options?.label).toBe('function')
    expect(options?.locale).toBe(LOCALE_NS)
  })

  it('label 是函数（语言切换后要重新取值）', () => {
    const world = createWorld()
    apply(world.ctx)

    const label = world.sections[0]?.options.label as () => string
    expect(label()).toBe('t:nav')
  })

  it('注册的是**包装组件**：scope / t / loadSessions 必须真的递进去', () => {
    const world = createWorld()
    apply(world.ctx)

    // 直接把组件函数调一次即可拿到 React element（不需要 DOM）
    const component = world.sections[0]?.component as (owner: { close: () => void }) => {
      props: Record<string, unknown>
    }
    const element = component({ close: () => undefined })

    // `settings.section` 的 owner **只传 close**，分区自己的数据必须靠注册时闭包带进去。
    // 直接注册裸组件的话这三个全是 undefined —— 界面会永远停在"正在读取状态…"、
    // 目标会话也永远只能手填（这是 M0 探针里真实出现的两个现象）。
    expect(typeof element.props.t).toBe('function')
    expect(element.props.scope).toBeDefined()
    expect(typeof element.props.loadSessions).toBe('function')
    expect((element.props.t as (key: string) => string)('nav')).toBe('t:nav')
  })
})

describe('client 入口 — 配置通道', () => {
  it('用 heartbeat 命名空间绑定 settingsScope', () => {
    const world = createWorld()
    apply(world.ctx)

    expect(world.settingsScopeNamespaces).toEqual(['heartbeat'])
  })
})
