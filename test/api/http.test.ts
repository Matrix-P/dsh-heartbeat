import { describe, expect, it } from 'vitest'

import type { ConfigIssue } from '../../src/config.js'
import type { HeartbeatApiDeps, HttpRequestLike } from '../../src/api/http.js'
import {
  createHeartbeatApi,
  API_PATHS,
  STATE_PATH,
  FIRE_PATH,
  SESSIONS_PATH,
} from '../../src/api/http.js'
import type { TaskSnapshot } from '../../src/runtime/orchestrator.js'

const NOW = Date.UTC(2026, 8, 21, 0, 0, 0)

function snapshot(overrides: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return {
    id: 'daily',
    name: '早间问候',
    status: 'armed',
    nextFireAt: NOW + 1_800_000,
    fireCount: 3,
    noReplyStreak: 0,
    lastResult: 'queued',
    lastFiredAt: NOW - 86_400_000,
    suspendReason: null,
    suspendedAt: null,
    errorReason: null,
    supersededBy: null,
    ...overrides,
  }
}

interface ApiEnv {
  readonly deps: HeartbeatApiDeps
  readonly fired: string[]
  readonly warnings: ConfigIssue[]
  tasks: TaskSnapshot[]
}

function createEnv(): ApiEnv {
  const fired: string[] = []
  const warnings: ConfigIssue[] = []
  const env: ApiEnv = {
    fired,
    warnings,
    tasks: [snapshot()],
    deps: {
      snapshot: () => env.tasks,
      knownTaskIds: () => env.tasks.map((task) => task.id),
      fire: async (taskId) => {
        fired.push(taskId)
      },
      // 会话候选：默认空，具体用例自己覆盖
      sessions: async () => [],
      now: () => NOW,
      timezone: 'Asia/Shanghai',
      globalEnabled: () => true,
      warnings: () => warnings,
    },
  }
  return env
}

function request(overrides: Partial<HttpRequestLike> = {}): HttpRequestLike {
  return {
    method: 'GET',
    path: STATE_PATH,
    query: new Map(),
    fromLoopback: true,
    ...overrides,
  }
}

function parse(body: string): any {
  return JSON.parse(body)
}

describe('HeartbeatApi — GET /state（技术设计 11.3）', () => {
  it('返回 200 与 JSON', async () => {
    const api = createHeartbeatApi(createEnv().deps)
    const response = await api.handle(request())

    expect(response.status).toBe(200)
    expect(response.contentType).toContain('application/json')
  })

  it('响应体包含全局状态与任务快照的全部字段', async () => {
    const api = createHeartbeatApi(createEnv().deps)
    const body = parse((await api.handle(request())).body)

    expect(body.now).toBe(NOW)
    expect(body.timezone).toBe('Asia/Shanghai')
    expect(body.globalEnabled).toBe(true)
    expect(body.tasks).toHaveLength(1)
    expect(body.tasks[0]).toMatchObject({
      id: 'daily',
      name: '早间问候',
      status: 'armed',
      nextFireAt: NOW + 1_800_000,
      fireCount: 3,
      noReplyStreak: 0,
      suspendReason: null,
      errorReason: null,
      supersededBy: null,
    })
  })

  it('带上加载期的 warnings，供界面提示', async () => {
    const env = createEnv()
    env.warnings.push({ path: 'tasks[0].schedule.at', message: 'once 已过期' })
    const api = createHeartbeatApi(env.deps)

    const body = parse((await api.handle(request())).body)
    expect(body.warnings).toHaveLength(1)
  })

  it('非 loopback 也允许读取（只读不敏感）', async () => {
    const api = createHeartbeatApi(createEnv().deps)
    expect((await api.handle(request({ fromLoopback: false }))).status).toBe(200)
  })
})

describe('HeartbeatApi — POST /fire（FR-6 第 2 条）', () => {
  it('触发指定任务并返回 200', async () => {
    const env = createEnv()
    const api = createHeartbeatApi(env.deps)

    const response = await api.handle(
      request({ method: 'POST', path: FIRE_PATH, body: JSON.stringify({ id: 'daily' }) }),
    )

    expect(response.status).toBe(200)
    expect(env.fired).toEqual(['daily'])
    expect(parse(response.body).ok).toBe(true)
  })

  it('未知任务 id → 404', async () => {
    const env = createEnv()
    const api = createHeartbeatApi(env.deps)

    const response = await api.handle(
      request({ method: 'POST', path: FIRE_PATH, body: JSON.stringify({ id: 'nope' }) }),
    )

    expect(response.status).toBe(404)
    expect(env.fired).toEqual([])
  })

  it('body 不是合法 JSON → 400', async () => {
    const api = createHeartbeatApi(createEnv().deps)
    const response = await api.handle(request({ method: 'POST', path: FIRE_PATH, body: '{oops' }))
    expect(response.status).toBe(400)
  })

  it('body 缺少 id → 400', async () => {
    const api = createHeartbeatApi(createEnv().deps)
    const response = await api.handle(request({ method: 'POST', path: FIRE_PATH, body: '{}' }))
    expect(response.status).toBe(400)
  })

  it('非 loopback 的写操作 → 403（与 DSH 设置面的只读约定一致）', async () => {
    const env = createEnv()
    const api = createHeartbeatApi(env.deps)

    const response = await api.handle(
      request({
        method: 'POST',
        path: FIRE_PATH,
        body: JSON.stringify({ id: 'daily' }),
        fromLoopback: false,
      }),
    )

    expect(response.status).toBe(403)
    expect(env.fired).toEqual([])
  })

  it('任务抛错时返回 500 而不是把异常漏出去', async () => {
    const env = createEnv()
    const api = createHeartbeatApi({
      ...env.deps,
      fire: async () => {
        throw new Error('投递炸了')
      },
    })

    const response = await api.handle(
      request({ method: 'POST', path: FIRE_PATH, body: JSON.stringify({ id: 'daily' }) }),
    )

    expect(response.status).toBe(500)
    expect(response.body).toContain('投递炸了')
  })
})

describe('HeartbeatApi — 路由边界', () => {
  it('未知路径 → 404', async () => {
    const api = createHeartbeatApi(createEnv().deps)
    expect((await api.handle(request({ path: '/api/heartbeat/nope' }))).status).toBe(404)
  })

  it('路径对但方法不对 → 405', async () => {
    const api = createHeartbeatApi(createEnv().deps)
    expect((await api.handle(request({ method: 'PUT', path: STATE_PATH }))).status).toBe(405)
    expect((await api.handle(request({ method: 'GET', path: FIRE_PATH }))).status).toBe(405)
    expect((await api.handle(request({ method: 'POST', path: SESSIONS_PATH }))).status).toBe(405)
  })
})

describe('HeartbeatApi — 端点清单（防"加了 handler 忘了注册路由"）', () => {
  it('API_PATHS 里的每个端点都被 handle 认领，不会掉到 404', async () => {
    const api = createHeartbeatApi(createEnv().deps)

    for (const path of API_PATHS) {
      const isFire = path === FIRE_PATH
      const response = await api.handle(
        request({
          method: isFire ? 'POST' : 'GET',
          path,
          ...(isFire ? { body: JSON.stringify({ id: 'daily' }) } : {}),
        }),
      )
      // 未注册的端点会被 DSH 的统一鉴权门接管返回 401；这里先保证「纯 API 层认领了它」
      expect(response.status, `${path} 没有被 handle 认领`).not.toBe(404)
    }
  })

  it('API_PATHS 与三个具名端点一一对应（没有漏也没有多）', () => {
    expect([...API_PATHS].sort()).toEqual([STATE_PATH, SESSIONS_PATH, FIRE_PATH].sort())
  })
})

describe('HeartbeatApi — 会话候选接口（设计 10.5）', () => {
  it('GET 返回候选列表', async () => {
    const env = createEnv()
    const api = createHeartbeatApi({
      ...env.deps,
      sessions: async () => [
        { sessionId: 's1', title: '和朋友的对话', kind: 'root' as const, updatedAt: NOW },
      ],
    })

    const response = await api.handle(request({ path: SESSIONS_PATH }))

    expect(response.status).toBe(200)
    expect(JSON.parse(response.body)).toEqual({
      candidates: [{ sessionId: 's1', title: '和朋友的对话', kind: 'root', updatedAt: NOW }],
    })
  })

  it('候选读失败也返回 200 + 空列表（界面退化成手填，而不是报错）', async () => {
    const env = createEnv()
    const api = createHeartbeatApi({
      ...env.deps,
      sessions: async () => {
        throw new Error('sessionQuery 不可用')
      },
    })

    const response = await api.handle(request({ path: SESSIONS_PATH }))

    expect(response.status).toBe(200)
    const body = JSON.parse(response.body) as { candidates: unknown[]; error?: string }
    expect(body.candidates).toEqual([])
    expect(body.error).toContain('sessionQuery')
  })
})
