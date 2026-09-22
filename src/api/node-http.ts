/**
 * Node HTTP 处理器：把 {@link HeartbeatApi} 接到 `ctx.webServer.register` 上。
 *
 * 【事实】官方契约（`@deepseek-ai/dsh-host-webserver` 的 `lib/types/index.d.ts`）：
 *
 * ```ts
 * interface WebRoute {
 *   kind: 'exact' | 'prefix'
 *   path: string
 *   handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
 * }
 * register(route: WebRoute): () => void   // 返回 disposer
 * ```
 *
 * handler **自己拥有整个响应生命周期**，所以这里负责：解析 URL、收集请求体、
 * 判定来源是否为本机、写状态码与响应体、并把一切异常收在内部（绝不漏给框架）。
 *
 * 本模块用**结构性最小接口**（而不是直接 import `node:http` 的具体类型），
 * 这样可以用普通对象做假件单测；真实的 `IncomingMessage` / `ServerResponse`
 * 在结构上完全满足它们。
 */

import type { HeartbeatApi, HttpRequestLike, HttpResponseLike } from './http.js'

export interface NodeRequestLike {
  readonly method?: string
  readonly url?: string
  readonly socket?: { readonly remoteAddress?: string }
  on(event: string, listener: (...args: any[]) => void): unknown
}

export interface NodeResponseLike {
  statusCode: number
  setHeader(name: string, value: string): void
  end(body?: string): void
}

export interface NodeHttpHandlerOptions {
  /** 请求体上限，防止一个畸形请求把内存吃光。@default 64 KiB */
  readonly maxBodyBytes?: number
}

const DEFAULT_MAX_BODY_BYTES = 64 * 1024

const LOOPBACK_LITERALS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/** 判定来源地址是否为本机（IPv4 `127.0.0.0/8` 与 IPv6 `::1`）。 */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) return false
  if (LOOPBACK_LITERALS.has(address)) return true
  if (address.startsWith('127.')) return true
  return address.startsWith('::ffff:127.')
}

function parseUrl(rawUrl: string | undefined): {
  path: string
  query: Map<string, string>
} {
  const fallback = { path: '/', query: new Map<string, string>() }
  if (rawUrl === undefined || rawUrl === '') return fallback

  let parsed: URL
  try {
    // 相对 URL 用占位 base 解析；绝对 URL（代理场景）也能正确处理
    parsed = new URL(rawUrl, 'http://localhost')
  } catch {
    return fallback
  }

  return { path: parsed.pathname, query: new Map(parsed.searchParams.entries()) }
}

/** 收集请求体；超过上限时返回 `null`（调用方回 413）。 */
function readBody(
  request: NodeRequestLike,
  maxBodyBytes: number,
): Promise<string | null | Error> {
  return new Promise((resolve) => {
    const chunks: string[] = []
    let size = 0
    let settled = false

    const finish = (value: string | null | Error): void => {
      if (settled) return
      settled = true
      resolve(value)
    }

    request.on('data', (chunk: unknown) => {
      const text = typeof chunk === 'string' ? chunk : String(chunk)
      size += Buffer.byteLength(text)
      if (size > maxBodyBytes) {
        finish(null)
        return
      }
      chunks.push(text)
    })

    request.on('end', () => {
      finish(chunks.join(''))
    })

    request.on('error', (error: unknown) => {
      finish(error instanceof Error ? error : new Error(String(error)))
    })
  })
}

function write(response: NodeResponseLike, result: HttpResponseLike): void {
  response.statusCode = result.status
  response.setHeader('content-type', result.contentType)
  // 状态查询是私密信息，别让任何中间层缓存
  response.setHeader('cache-control', 'no-store')
  response.end(result.body)
}

/**
 * 把 API 包成 `ctx.webServer.register({ kind: 'exact', path, handler })` 需要的处理器。
 *
 * 注意：**路由前缀的匹配由 host 负责**，这里只处理已经进来的请求。
 */
export function createNodeHttpHandler(
  api: HeartbeatApi,
  options: NodeHttpHandlerOptions = {},
): (request: NodeRequestLike, response: NodeResponseLike) => Promise<void> {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES

  return async (request, response) => {
    try {
      const { path, query } = parseUrl(request.url)
      const method = request.method ?? 'GET'

      let body: string | undefined
      if (method !== 'GET' && method !== 'HEAD') {
        const collected = await readBody(request, maxBodyBytes)
        if (collected === null) {
          write(response, {
            status: 413,
            contentType: 'text/plain; charset=utf-8',
            body: `请求体超过上限（${maxBodyBytes} 字节）`,
          })
          return
        }
        if (collected instanceof Error) {
          write(response, { status: 400, contentType: 'text/plain; charset=utf-8', body: '读取请求体失败' })
          return
        }
        body = collected
      }

      const httpRequest: HttpRequestLike = {
        method,
        path,
        query,
        fromLoopback: isLoopbackAddress(request.socket?.remoteAddress),
        ...(body === undefined ? {} : { body }),
      }

      write(response, await api.handle(httpRequest))
    } catch (error) {
      // 处理器拥有整个响应生命周期：任何异常都必须在这里转成响应，绝不漏给框架
      write(response, {
        status: 500,
        contentType: 'text/plain; charset=utf-8',
        body: `心跳接口内部错误：${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }
}
