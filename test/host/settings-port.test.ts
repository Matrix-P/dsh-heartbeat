/**
 * 配置通道适配层的测试（DSH 0.1.x ↔ 0.2.x）。
 *
 * 这一层存在的唯一理由：**两代的 settings API 互斥**（0.1.x 有 `settings.register`，
 * 0.2.x 的 `SettingsForms` 没有）。所以这里要把"探测到哪一代 → 走哪条路"钉死，
 * 否则线上表现会是"插件起不来"或"配置读不到"，而且都很难看出来。
 */

import { describe, expect, it } from 'vitest'

import type { ConfigChannelOptions, ServiceLookup } from '../../src/host/settings-port.js'
import { openConfigChannel, resolveLegacySettings } from '../../src/host/settings-port.js'

interface Registration {
  readonly namespace: string
  readonly schema: unknown
  readonly options: { base?: unknown; applies?: string; validate?: (value: unknown) => void }
}

/** 伪造 0.1.x 的 settings 服务。 */
function legacyLookup(after: unknown = { tasks: [] }): {
  lookup: ServiceLookup
  registrations: Registration[]
  emit(next: unknown): void
} {
  const registrations: Registration[] = []
  const listeners: Array<(next: unknown) => void> = []
  let current = after

  const lookup: ServiceLookup = {
    get: (name) =>
      name === 'settings'
        ? {
            register(namespace: string, schema: unknown, options: Registration['options']) {
              registrations.push({ namespace, schema, options })
              return {
                get: () => current,
                watch(listener: (next: unknown) => void) {
                  listeners.push(listener)
                  return () => undefined
                },
              }
            },
          }
        : undefined,
  }

  return {
    lookup,
    registrations,
    emit(next) {
      current = next
      for (const listener of listeners) listener(next)
    },
  }
}

/** 伪造 0.2.x 的 settings 服务：服务在，但没有 `register`。 */
function formsLookup(): ServiceLookup {
  return {
    get: (name) => (name === 'settings' ? { describe: () => [], update: () => Promise.resolve() } : undefined),
  }
}

const OPTIONS: ConfigChannelOptions = {
  namespace: 'heartbeat',
  schema: { marker: 'schema' },
  rawConfig: { enabled: true, tasks: [] },
  validate: () => undefined,
}

describe('resolveLegacySettings — 靠运行时探测区分两代', () => {
  it('服务不在 → undefined（不抛，R18 的读法）', () => {
    expect(resolveLegacySettings({ get: () => undefined })).toBeUndefined()
  })

  it('0.2.x 的 SettingsForms（没有 register）→ undefined', () => {
    expect(resolveLegacySettings(formsLookup())).toBeUndefined()
  })

  it('0.1.x 的 settings（有 register）→ 返回服务本身', () => {
    const { lookup } = legacyLookup()
    expect(typeof resolveLegacySettings(lookup)?.register).toBe('function')
  })
})

describe('openConfigChannel — 0.1.x 路径', () => {
  it('注册命名空间，并把入口 config 作为 base、validate 透传（写前校验）', () => {
    const { lookup, registrations } = legacyLookup()
    const validate = () => undefined

    openConfigChannel(lookup, { ...OPTIONS, validate })

    expect(registrations).toHaveLength(1)
    expect(registrations[0]?.namespace).toBe('heartbeat')
    expect(registrations[0]?.schema).toBe(OPTIONS.schema)
    expect(registrations[0]?.options.base).toEqual({ enabled: true, tasks: [] })
    expect(registrations[0]?.options.applies).toBe('live')
    expect(registrations[0]?.options.validate).toBe(validate)
  })

  it('base 不是对象时退化成空对象（交给 schema 默认值兜底）', () => {
    const { lookup, registrations } = legacyLookup()
    openConfigChannel(lookup, { ...OPTIONS, rawConfig: 'not-an-object' })
    expect(registrations[0]?.options.base).toEqual({})
  })

  it('initial 取注册后的当前值；subscribe 走 watch（热更新）', () => {
    const { lookup, emit } = legacyLookup({ enabled: false })
    const channel = openConfigChannel(lookup, OPTIONS)

    expect(channel.registered).toBe(true)
    expect(channel.initial).toEqual({ enabled: false })

    const seen: unknown[] = []
    channel.subscribe((next) => seen.push(next))
    emit({ enabled: true })
    expect(seen).toEqual([{ enabled: true }])
  })
})

describe('openConfigChannel — 0.2.x 路径', () => {
  it('不注册，直接拿 Loader 行那份 config；registered=false', () => {
    const channel = openConfigChannel(formsLookup(), OPTIONS)

    expect(channel.registered).toBe(false)
    expect(channel.initial).toEqual({ enabled: true, tasks: [] })
  })

  it('subscribe 是 no-op（配置变更会带着新 config 重新挂载本插件）', () => {
    const channel = openConfigChannel(formsLookup(), OPTIONS)
    const dispose = channel.subscribe(() => {
      throw new Error('0.2.x 下不该有热更新回调')
    })
    expect(typeof dispose).toBe('function')
    expect(() => dispose()).not.toThrow()
  })
})
