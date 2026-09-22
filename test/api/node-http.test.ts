import { describe, expect, it } from 'vitest'

import type { HeartbeatApi, HttpRequestLike } from '../../src/api/http.js'
import type { NodeRequestLike, NodeResponseLike } from '../../src/api/node-http.js'
import { createNodeHttpHandler, isLoopbackAddress } from '../../src/api/node-http.js'

interface Handled {
  readonly requests: HttpRequestLike[]
  readonly api: HeartbeatApi
}

function createApi(): Handled {
  const requests: HttpRequestLike[] = []
  return {
    requests,
    api: {
      async handle(request) {
        requests.push(request)
        if (request.path === '/api/heartbeat/state') {
          return {
            status: 200,
            contentType: 'application/json; charset=utf-8',
            body: JSON.stringify({ fromLoopback: request.fromLoopback, query: [...request.query] }),
          }
        }
        return { status: 200, contentType: 'text/plain; charset=utf-8', body: `body=${request.body ?? ''}` }
      },
    },
  }
}

function fakeRequest(options: {
  method?: string
  url?: string
  remoteAddress?: string
  body?: string
  /** 分片到达的请求体；优先于 body */
  chunks?: readonly string[]
  failWith?: Error
} = {}): NodeRequestLike {
  const listeners = new Map<string, Array<(...args: any[]) => void>>()

  const request: NodeRequestLike = {
    method: options.method ?? 'GET',
    url: options.url ?? '/',
    socket: { remoteAddress: options.remoteAddress ?? '127.0.0.1' },
    on(event, listener) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return request
    },
  }

  queueMicrotask(() => {
    if (options.failWith !== undefined) {
      for (const listener of listeners.get('error') ?? []) listener(options.failWith)
      return
    }

    const payload = options.chunks ?? (options.body === undefined ? [] : [options.body])
    for (const chunk of payload) {
      for (const listener of listeners.get('data') ?? []) listener(Buffer.from(chunk, 'utf8'))
    }
    for (const listener of listeners.get('end') ?? []) listener()
  })

  return request
}

interface Captured {
  readonly response: NodeResponseLike
  status(): number
  header(name: string): string | undefined
  body(): string
  ended(): boolean
}

function fakeResponse(): Captured {
  const headers = new Map<string, string>()
  let statusCode = 0
  let chunks = ''
  let isEnded = false

  const response: NodeResponseLike = {
    get statusCode() {
      return statusCode
    },
    set statusCode(value: number) {
      statusCode = value
    },
    setHeader(name, value) {
      headers.set(name.toLowerCase(), value)
    },
    end(body) {
      if (body !== undefined) chunks += body
      isEnded = true
    },
  }

  return {
    response,
    status: () => statusCode,
    header: (name) => headers.get(name.toLowerCase()),
    body: () => chunks,
    ended: () => isEnded,
  }
}

describe('isLoopbackAddress', () => {
  it('IPv4 回环', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('127.9.9.9')).toBe(true)
  })

  it('IPv6 回环（含 IPv4 映射形式）', () => {
    expect(isLoopbackAddress('::1')).toBe(true)
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true)
  })

  it('外部地址与未知地址一律不算回环', () => {
    expect(isLoopbackAddress('192.168.1.5')).toBe(false)
    expect(isLoopbackAddress('::ffff:192.168.1.5')).toBe(false)
    expect(isLoopbackAddress(undefined)).toBe(false)
  })
})

describe('createNodeHttpHandler — 路由与响应', () => {
  it('把 Node 请求翻译成 HttpRequestLike 并写回响应', async () => {
    const { api, requests } = createApi()
    const handler = createNodeHttpHandler(api)
    const captured = fakeResponse()

    await handler(
      fakeRequest({ method: 'GET', url: '/api/heartbeat/state', remoteAddress: '127.0.0.1' }),
      captured.response,
    )

    expect(requests[0]).toMatchObject({
      method: 'GET',
      path: '/api/heartbeat/state',
      fromLoopback: true,
    })
    expect(captured.status()).toBe(200)
    expect(captured.header('content-type')).toContain('application/json')
    expect(captured.ended()).toBe(true)
    expect(JSON.parse(captured.body())).toMatchObject({ fromLoopback: true })
  })

  it('解析 query string', async () => {
    const { api, requests } = createApi()
    const handler = createNodeHttpHandler(api)
    const captured = fakeResponse()

    await handler(fakeRequest({ url: '/api/heartbeat/state?a=1&b=two' }), captured.response)

    expect(requests[0]?.query.get('a')).toBe('1')
    expect(requests[0]?.query.get('b')).toBe('two')
  })

  it('收集 POST 请求体并交给 api', async () => {
    const { api, requests } = createApi()
    const handler = createNodeHttpHandler(api)
    const captured = fakeResponse()

    await handler(
      fakeRequest({ method: 'POST', url: '/api/heartbeat/fire', body: '{"id":"daily"}' }),
      captured.response,
    )

    expect(requests[0]?.body).toBe('{"id":"daily"}')
    expect(captured.body()).toBe('body={"id":"daily"}')
  })

  it('分片到达的请求体会被拼起来', async () => {
    const { api, requests } = createApi()
    const handler = createNodeHttpHandler(api)
    const captured = fakeResponse()

    await handler(
      fakeRequest({
        method: 'POST',
        url: '/api/heartbeat/fire',
        chunks: ['{"id"', ':', '"daily"', '}'],
      }),
      captured.response,
    )

    expect(requests[0]?.body).toBe('{"id":"daily"}')
  })

  it('非回环来源会被如实标记（写操作由 api 拒绝）', async () => {
    const { api, requests } = createApi()
    const handler = createNodeHttpHandler(api)
    const captured = fakeResponse()

    await handler(fakeRequest({ url: '/api/heartbeat/state', remoteAddress: '10.0.0.7' }), captured.response)

    expect(requests[0]?.fromLoopback).toBe(false)
  })

  it('URL 非法时兜底成根路径，不抛异常', async () => {
    const { api, requests } = createApi()
    const handler = createNodeHttpHandler(api)
    const captured = fakeResponse()

    await handler(fakeRequest({ url: 'http://[bad' }), captured.response)

    expect(requests[0]?.path).toBeTruthy()
    expect(captured.ended()).toBe(true)
  })
})

describe('createNodeHttpHandler — 异常与上限', () => {
  it('请求体超过上限 → 413，且不调用 api', async () => {
    const { api, requests } = createApi()
    const handler = createNodeHttpHandler(api, { maxBodyBytes: 8 })
    const captured = fakeResponse()

    await handler(
      fakeRequest({ method: 'POST', url: '/api/heartbeat/fire', body: '{"id":"way-too-long"}' }),
      captured.response,
    )

    expect(captured.status()).toBe(413)
    expect(requests).toHaveLength(0)
  })

  it('请求流报错 → 400，不把异常漏出去', async () => {
    const { api } = createApi()
    const handler = createNodeHttpHandler(api)
    const captured = fakeResponse()

    // 只有带请求体的方法才会去读流
    await handler(
      fakeRequest({ method: 'POST', url: '/api/heartbeat/fire', failWith: new Error('socket 断了') }),
      captured.response,
    )

    expect(captured.status()).toBe(400)
    expect(captured.ended()).toBe(true)
  })

  it('api 自身抛错 → 500，不把异常漏出去', async () => {
    const handler = createNodeHttpHandler({
      async handle() {
        throw new Error('内部炸了')
      },
    })
    const captured = fakeResponse()

    await handler(fakeRequest(), captured.response)

    expect(captured.status()).toBe(500)
    expect(captured.ended()).toBe(true)
  })
})
