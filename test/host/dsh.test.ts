/**
 * host 胶水层的回归测试（R18）。
 *
 * 背景：这一层原先没有单测（当时判断它只是类型安全的映射，靠 tsc + 探针保证）。
 * M0 探针抓出一个真实 bug，而它**恰恰只能在这一层暴露**：
 *
 *   cordis 4 里读一个自己没有 `inject` 的服务会**抛错**
 *   （`cannot get property "webServer" without inject`），
 *   而不是返回 undefined。
 *
 * 于是原来的「按可选处理：`(ctx as { webServer?: … }).webServer`」写法会让
 * `apply` 直接抛异常，插件整个起不来。正确写法只有一条路：
 * `ctx.get(name)`（拿不到返回 undefined）+ `ctx.inject([name], cb)`（等服务出现后补挂）。
 *
 * 这个文件用**真的 cordis**跑，因此能同时钉住三件事：
 * 1. 上面的规则本身（直读会抛）；
 * 2. 服务缺席时我们的函数不抛、也不挂东西；
 * 3. 服务稍后出现时，路由 / 冷唤醒能力会被补上。
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'

import type { HeartbeatApi } from '../../src/api/http.js'
import { API_PATHS } from '../../src/api/http.js'
import type { DeliveryPort } from '../../src/delivery/deliver.js'
import { createHostDeliveryPort, registerHeartbeatRoutes } from '../../src/host/dsh.js'

const API: HeartbeatApi = {
  handle: () =>
    Promise.resolve({ status: 200, contentType: 'text/plain; charset=utf-8', body: 'ok' }),
}

/**
 * 期望注册的路由 = **API 自己声明的全部端点**。
 *
 * 不要在这里手写路径清单：曾经 `SESSIONS_PATH` 加进了 `api/http.ts` 的
 * `handle()` 分支却没加进 host 的注册清单，而未注册的 `/api/*` 会掉进
 * DSH 的统一鉴权门返回 401（客户端静默退回手填，host 侧毫无异常）。
 * 按 `API_PATHS` 断言，漏注册立刻红。
 */
const EXPECTED_ROUTES = [...API_PATHS]

/** cordis 的激活是异步的，给微任务/宏任务留一拍。 */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20))

class FakeWebServer extends Service {
  readonly routes: string[] = []
  readonly disposed: string[] = []

  constructor(ctx: Context) {
    super(ctx, 'webServer')
  }

  register(options: { kind: string; path: string }): () => void {
    this.routes.push(options.path)
    return () => {
      this.disposed.push(options.path)
    }
  }
}

class FakeAgents extends Service {
  constructor(ctx: Context) {
    super(ctx, 'agents')
  }

  get(): undefined {
    return undefined
  }

  roots(): readonly never[] {
    return []
  }

  isOwnedBy(): boolean {
    return false
  }
}

class FakeSessionController extends Service {
  readonly resolved: string[] = []

  constructor(ctx: Context) {
    super(ctx, 'sessionController')
  }

  resolveAgent(sessionId: string): Promise<void> {
    this.resolved.push(sessionId)
    return Promise.resolve()
  }
}

describe('R18：cordis 未 inject 的服务是抛错，不是 undefined', () => {
  it('直读未 inject 的服务会抛 `cannot get property … without inject`', async () => {
    const app = new Context()
    let direct: unknown
    let viaGet: unknown

    app.plugin({
      name: 'probe',
      inject: [],
      apply(ctx) {
        try {
          direct = ctx.webServer
        } catch (error) {
          direct = error
        }
        viaGet = ctx.get('webServer')
      },
    })
    await settle()

    expect(direct).toBeInstanceOf(Error)
    expect((direct as Error).message).toContain('without inject')
    // 同一个服务，用 ctx.get 就是安全的
    expect(viaGet).toBeUndefined()
  })
})

describe('registerHeartbeatRoutes — webServer 缺席不能拖挂插件（R18）', () => {
  it('没有 webServer 时不抛，也不挂任何路由', async () => {
    const app = new Context()
    let thrown: unknown

    app.plugin({
      name: 'heartbeat',
      inject: [],
      apply(ctx) {
        try {
          registerHeartbeatRoutes(ctx, API)
        } catch (error) {
          thrown = error
        }
      },
    })
    await settle()

    expect(thrown).toBeUndefined()
  })

  it('webServer 稍后出现 → 两条路由都被补挂上', async () => {
    const app = new Context()
    let web: FakeWebServer | undefined

    app.plugin({
      name: 'heartbeat',
      inject: [],
      apply(ctx) {
        registerHeartbeatRoutes(ctx, API)
      },
    })
    await settle()
    expect(web).toBeUndefined()

    app.plugin({
      name: 'web-app',
      inject: [],
      apply(ctx) {
        web = new FakeWebServer(ctx)
      },
    })
    await settle()

    expect(web?.routes).toEqual(EXPECTED_ROUTES)
  })

  it('webServer 已就绪 → 立即挂上（不需要等下一拍）', async () => {
    const app = new Context()
    let web: FakeWebServer | undefined

    app.plugin({
      name: 'web-app',
      inject: [],
      apply(ctx) {
        web = new FakeWebServer(ctx)
      },
    })
    await settle()

    app.plugin({
      name: 'heartbeat',
      inject: [],
      apply(ctx) {
        registerHeartbeatRoutes(ctx, API)
      },
    })
    await settle()

    expect(web?.routes).toEqual(EXPECTED_ROUTES)
  })

  it('已就绪时路由挂在**我们自己的** fiber 上，我们卸载时反注册', async () => {
    const app = new Context()
    let web: FakeWebServer | undefined

    app.plugin({
      name: 'web-app',
      inject: [],
      apply(ctx) {
        web = new FakeWebServer(ctx)
      },
    })
    await settle()

    const reader = app.plugin({
      name: 'heartbeat',
      inject: [],
      apply(ctx) {
        registerHeartbeatRoutes(ctx, API)
      },
    })
    await settle()
    expect(web?.routes).toEqual(EXPECTED_ROUTES)

    await reader.dispose()
    await settle()

    expect(web?.disposed).toEqual(EXPECTED_ROUTES)
  })

  it('延迟路径下挂在**注入作用域**上，webServer 卸载时反注册', async () => {
    const app = new Context()
    let web: FakeWebServer | undefined

    // 我们比 webServer 先起来 → 走 ctx.inject 延迟注册
    app.plugin({
      name: 'heartbeat',
      inject: [],
      apply(ctx) {
        registerHeartbeatRoutes(ctx, API)
      },
    })
    await settle()

    const webApp = app.plugin({
      name: 'web-app',
      inject: [],
      apply(ctx) {
        web = new FakeWebServer(ctx)
      },
    })
    await settle()
    expect(web?.routes).toEqual(EXPECTED_ROUTES)

    await webApp.dispose()
    await settle()

    expect(web?.disposed).toEqual(EXPECTED_ROUTES)
  })
})

describe('createHostDeliveryPort — sessionController 缺席要降级成「没有冷唤醒」', () => {
  async function mountAgents(app: Context): Promise<void> {
    app.plugin({
      name: 'agents-provider',
      inject: [],
      apply(ctx) {
        new FakeAgents(ctx)
      },
    })
    await settle()
  }

  it('缺席时 port.warmUp 为 undefined，其它能力照常可用', async () => {
    const app = new Context()
    await mountAgents(app)

    let port: DeliveryPort | undefined
    app.plugin({
      name: 'heartbeat',
      inject: ['agents'],
      apply(ctx) {
        port = createHostDeliveryPort(ctx)
      },
    })
    await settle()

    expect(port).toBeDefined()
    expect(port?.warmUp).toBeUndefined()
    // 没有 live Agent → isLive 为 false，且不抛
    expect(port?.isLive('s1')).toBe(false)
    expect(port?.statusOf('s1')).toBeUndefined()
  })

  it('稍后出现 → warmUp 变为可用，并能真的唤醒会话', async () => {
    const app = new Context()
    await mountAgents(app)

    let port: DeliveryPort | undefined
    app.plugin({
      name: 'heartbeat',
      inject: ['agents'],
      apply(ctx) {
        port = createHostDeliveryPort(ctx)
      },
    })
    await settle()
    expect(port?.warmUp).toBeUndefined()

    let controller: FakeSessionController | undefined
    app.plugin({
      name: 'web-app',
      inject: [],
      apply(ctx) {
        controller = new FakeSessionController(ctx)
      },
    })
    await settle()

    expect(port?.warmUp).toBeDefined()
    await port?.warmUp?.('s1')
    expect(controller?.resolved).toEqual(['s1'])
  })

  it('已就绪时 warmUp 直接可用', async () => {
    const app = new Context()
    await mountAgents(app)

    let controller: FakeSessionController | undefined
    app.plugin({
      name: 'web-app',
      inject: [],
      apply(ctx) {
        controller = new FakeSessionController(ctx)
      },
    })
    await settle()

    let port: DeliveryPort | undefined
    app.plugin({
      name: 'heartbeat',
      inject: ['agents'],
      apply(ctx) {
        port = createHostDeliveryPort(ctx)
      },
    })
    await settle()

    expect(port?.warmUp).toBeDefined()
    await port?.warmUp?.('s2')
    expect(controller?.resolved).toEqual(['s2'])
  })
})
