/**
 * 客户端配置通道适配层的测试。
 *
 * 存在理由与 `host/settings-port.test.ts` 对称：两代的客户端配置 API **互斥**
 * （0.1.x 的 `settingsScope` 在 0.2.x 里已完全移除，替代品是 `configForms`），
 * 所以「探测到哪一代 → 读哪里 → 写哪里」必须被钉死。
 */

import { describe, expect, it } from 'vitest'

import type { ConfigFormsService, ServiceLookup } from '../../src/client/config-port.js'
import { openClientConfigPort } from '../../src/client/config-port.js'

const OPTIONS = { namespace: 'heartbeat', entryId: 'dsh-heartbeat' }

/** 0.1.x：有 settingsScope。 */
function legacyLookup(): { lookup: ServiceLookup; bound: string[] } {
  const bound: string[] = []
  const scope = {
    getSnapshot: () => ({ status: 'ready' as const, value: { enabled: true, tasks: [] } }),
    subscribe: () => () => undefined,
    set: () => Promise.resolve(),
  }
  return {
    bound,
    lookup: {
      get: (name) => {
        if (name !== 'settingsScope') return undefined
        return {
          bind(spec: { namespace: string }) {
            bound.push(spec.namespace)
            return scope
          },
        }
      },
    },
  }
}

/** 0.2.x：没有 settingsScope，只有 configForms。 */
function formsLookup(
  descriptors: readonly { ns: string; value?: unknown; revision?: number; writable?: boolean }[],
): { lookup: ServiceLookup; updates: Array<{ ns: string; patch: object; revision?: number }> } {
  const updates: Array<{ ns: string; patch: object; revision?: number }> = []
  const forms: ConfigFormsService = {
    describe: () => descriptors,
    update: (ns, patch, revision) => {
      updates.push({ ns, patch, ...(revision === undefined ? {} : { revision }) })
      return Promise.resolve()
    },
  }
  return { updates, lookup: { get: (name) => (name === 'configForms' ? forms : undefined) } }
}

describe('openClientConfigPort — 两代自适应', () => {
  it('0.1.x：用 settingsScope，并按命名空间 bind', () => {
    const { lookup, bound } = legacyLookup()
    const port = openClientConfigPort(lookup, OPTIONS)

    expect(port).toBeDefined()
    expect(bound).toEqual(['heartbeat'])
    expect(port?.getSnapshot().status).toBe('ready')
  })

  it('0.2.x：用 configForms，按**行 id** 找配置（不是命名空间、不是包名）', () => {
    const { lookup } = formsLookup([
      { ns: 'dsh-heartbeat', value: { enabled: false, tasks: [{ id: 't1' }] }, revision: 7 },
      { ns: 'other-plugin', value: { enabled: true } },
    ])
    const port = openClientConfigPort(lookup, OPTIONS)

    const snapshot = port?.getSnapshot()
    expect(snapshot?.status).toBe('ready')
    expect(snapshot?.value?.enabled).toBe(false)
    expect(snapshot?.value?.tasks).toHaveLength(1)
  })

  it('0.2.x：找不到自己那条行 → unavailable（不抛）', () => {
    const { lookup } = formsLookup([{ ns: 'other-plugin', value: {} }])
    expect(openClientConfigPort(lookup, OPTIONS)?.getSnapshot().status).toBe('unavailable')
  })

  it('0.2.x：写走 update(行 id, patch, revision)', async () => {
    const { lookup, updates } = formsLookup([{ ns: 'dsh-heartbeat', value: {}, revision: 42 }])
    await openClientConfigPort(lookup, OPTIONS)?.set('tasks', [{ id: 't1' }])

    expect(updates).toEqual([{ ns: 'dsh-heartbeat', patch: { tasks: [{ id: 't1' }] }, revision: 42 }])
  })

  it('0.2.x：writable 为 false 时透传（界面据此禁用编辑）', () => {
    const { lookup } = formsLookup([{ ns: 'dsh-heartbeat', value: {}, writable: false }])
    expect(openClientConfigPort(lookup, OPTIONS)?.getSnapshot().writable).toBe(false)
  })

  it('0.2.x：subscribe 是 no-op（靠既有的 5 秒轮询刷新）', () => {
    const { lookup } = formsLookup([{ ns: 'dsh-heartbeat', value: {} }])
    const dispose = openClientConfigPort(lookup, OPTIONS)?.subscribe(() => {
      throw new Error('0.2.x 下不该有推送回调')
    })
    expect(typeof dispose).toBe('function')
    expect(() => dispose?.()).not.toThrow()
  })

  it('两代服务都没有 → undefined（调用方跳过自定义分区，绝不让插件卡住）', () => {
    expect(openClientConfigPort({ get: () => undefined }, OPTIONS)).toBeUndefined()
  })

  it('settingsScope 存在但不是服务（没有 bind）→ 退化去试 configForms', () => {
    const { lookup } = formsLookup([{ ns: 'dsh-heartbeat', value: { enabled: true } }])
    const mixed: ServiceLookup = {
      get: (name) => (name === 'settingsScope' ? {} : lookup.get(name)),
    }
    expect(openClientConfigPort(mixed, OPTIONS)?.getSnapshot().value?.enabled).toBe(true)
  })
})
