import { describe, expect, it } from 'vitest'

import type { TaskFileStoreFs } from '../../src/host/file-store.js'
import { createFileTaskStore, taskRecordPath, INSTANCE_FILE } from '../../src/host/file-store.js'
import type { InstanceInfo } from '../../src/runtime/store.js'
import type { TaskState } from '../../src/runtime/task-state.js'

const STATE: TaskState = {
  fireCount: 4,
  lastFiredAt: 1_789_000_000_000,
  lastResult: 'queued',
  noReplyStreak: 1,
  suspended: false,
  suspendReason: null,
  suspendedAt: null,
  completedAt: null,
  lastUserMsgAt: null,
  lastIdleAt: 1_788_999_000_000,
  anchorAt: 1_788_000_000_000,
  errorReason: null,
}

const INSTANCE: InstanceInfo = { pid: 4_242, startedAt: 1_789_000_000_000, host: 'host-a' }

interface FakeFs extends TaskFileStoreFs {
  readonly files: Map<string, string>
  readonly log: string[]
  failNextWrite: Error | undefined
  failNextRemove: Error | undefined
}

function fakeFs(initial?: Record<string, string>): FakeFs {
  const files = new Map<string, string>(Object.entries(initial ?? {}))
  const log: string[] = []

  const fs: FakeFs = {
    files,
    log,
    failNextWrite: undefined,
    failNextRemove: undefined,
    read: (path) => files.get(path),
    async write(path, content) {
      log.push(`write:${path}`)
      await Promise.resolve()
      if (fs.failNextWrite !== undefined) {
        const error = fs.failNextWrite
        fs.failNextWrite = undefined
        throw error
      }
      files.set(path, content)
    },
    async remove(path) {
      log.push(`remove:${path}`)
      await Promise.resolve()
      if (fs.failNextRemove !== undefined) {
        const error = fs.failNextRemove
        fs.failNextRemove = undefined
        throw error
      }
      files.delete(path)
    },
  }

  return fs
}

const DIR = 'C:/dsh/storages/heartbeat'

describe('taskRecordPath / INSTANCE_FILE', () => {
  it('每个任务一个 JSON 文件（按记录落盘，改一个不重写全部）', () => {
    expect(taskRecordPath(DIR, 'morning-greeting')).toBe(
      'C:/dsh/storages/heartbeat/tasks/morning-greeting.json',
    )
  })

  it('实例信息单独一个文件', () => {
    expect(INSTANCE_FILE).toBe('instance.json')
  })

  it('拒绝会逃出目录的任务 id（防路径穿越）', () => {
    expect(() => taskRecordPath(DIR, '../evil')).toThrow()
    expect(() => taskRecordPath(DIR, 'a/b')).toThrow()
    expect(() => taskRecordPath(DIR, '')).toThrow()
  })
})

describe('createFileTaskStore — 读取', () => {
  it('合法记录解析成状态', () => {
    const fs = fakeFs({ [taskRecordPath(DIR, 'daily')]: JSON.stringify({ fireCount: 4, anchorAt: 2 }) })
    const store = createFileTaskStore({ dir: DIR, fs })

    expect(store.load('daily')).toMatchObject({ fireCount: 4, anchorAt: 2 })
  })

  it('缺失字段补默认值（向前兼容旧记录）', () => {
    const fs = fakeFs({ [taskRecordPath(DIR, 'daily')]: '{}' })
    const store = createFileTaskStore({ dir: DIR, fs })
    expect(store.load('daily')?.fireCount).toBe(0)
  })

  it('坏 JSON / 坏记录返回 undefined 并上报，不抛错', () => {
    const fs = fakeFs({
      [taskRecordPath(DIR, 'bad-json')]: '{oops',
      [taskRecordPath(DIR, 'bad-shape')]: JSON.stringify({ fireCount: '不是数字' }),
    })
    const errors: string[] = []
    const store = createFileTaskStore({ dir: DIR, fs, onError: (taskId) => errors.push(taskId) })

    expect(store.load('bad-json')).toBeUndefined()
    expect(store.load('bad-shape')).toBeUndefined()
    expect(errors).toEqual(['bad-json', 'bad-shape'])
  })

  it('不存在的记录返回 undefined 且不报错（首次启动的正常情况）', () => {
    const errors: string[] = []
    const store = createFileTaskStore({ dir: DIR, fs: fakeFs(), onError: (id) => errors.push(id) })

    expect(store.load('nope')).toBeUndefined()
    expect(errors).toEqual([])
  })
})

describe('createFileTaskStore — 写入', () => {
  it('save 把序列化后的状态写进对应文件', async () => {
    const fs = fakeFs()
    const store = createFileTaskStore({ dir: DIR, fs })

    store.save('daily', STATE)
    await store.flush()

    expect(JSON.parse(fs.files.get(taskRecordPath(DIR, 'daily')) as string)).toEqual({
      fireCount: 4,
      lastFiredAt: 1_789_000_000_000,
      lastResult: 'queued',
      noReplyStreak: 1,
      suspended: false,
      suspendReason: null,
      suspendedAt: null,
      completedAt: null,
      lastUserMsgAt: null,
      lastIdleAt: 1_788_999_000_000,
      anchorAt: 1_788_000_000_000,
      errorReason: null,
    })
  })

  it('写入串行：同一任务连续写，最后一次胜出', async () => {
    const fs = fakeFs()
    const store = createFileTaskStore({ dir: DIR, fs })

    store.save('daily', { ...STATE, fireCount: 1 })
    store.save('daily', { ...STATE, fireCount: 2 })
    store.save('daily', { ...STATE, fireCount: 3 })
    await store.flush()

    expect(fs.log).toHaveLength(3)
    expect(JSON.parse(fs.files.get(taskRecordPath(DIR, 'daily')) as string).fireCount).toBe(3)
  })

  it('写入失败被捕获、计数、上报，不抛给调用方', async () => {
    const fs = fakeFs()
    const errors: unknown[] = []
    const store = createFileTaskStore({ dir: DIR, fs, onError: (_id, error) => errors.push(error) })

    fs.failNextWrite = new Error('磁盘满了')
    store.save('daily', STATE)
    await store.flush()

    expect(store.failures).toBe(1)
    expect(errors).toHaveLength(1)
  })

  it('remove 删除文件；失败同样被吞掉', async () => {
    const fs = fakeFs({ [taskRecordPath(DIR, 'daily')]: '{}' })
    const store = createFileTaskStore({ dir: DIR, fs })

    store.remove('daily')
    await store.flush()

    expect(fs.files.has(taskRecordPath(DIR, 'daily'))).toBe(false)
  })

  it('flush 之后仍可继续写', async () => {
    const fs = fakeFs()
    const store = createFileTaskStore({ dir: DIR, fs })

    store.save('a', STATE)
    await store.flush()
    store.save('b', STATE)
    await store.flush()

    expect(fs.files.size).toBe(2)
  })
})

describe('createFileTaskStore — 实例信息（单实例防御用）', () => {
  it('实例信息往返一致（走独立文件，不和任务状态混在一起）', async () => {
    const fs = fakeFs()
    const store = createFileTaskStore({ dir: DIR, fs })

    store.writeInstance(INSTANCE)
    await store.flush()

    expect(fs.files.has(`${DIR}/${INSTANCE_FILE}`)).toBe(true)
    expect(store.readInstance()).toEqual(INSTANCE)
  })

  it('首次启动读不到实例信息 → undefined（不报错）', () => {
    const errors: string[] = []
    const store = createFileTaskStore({ dir: DIR, fs: fakeFs(), onError: (id) => errors.push(id) })
    expect(store.readInstance()).toBeUndefined()
    expect(errors).toEqual([])
  })

  it('实例记录损坏 → undefined 且上报', () => {
    const fs = fakeFs({ [`${DIR}/${INSTANCE_FILE}`]: '{"pid":"x"}' })
    const errors: string[] = []
    const store = createFileTaskStore({ dir: DIR, fs, onError: (id) => errors.push(id) })

    expect(store.readInstance()).toBeUndefined()
    expect(errors).toHaveLength(1)
  })
})
