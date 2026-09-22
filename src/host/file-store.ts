/**
 * 文件存储适配（技术设计 4.1 的**实现替换**，见第 16 章 R17）。
 *
 * 【为什么不用 `dsh-storage-domain`】
 * 它要求记录 schema 用 **zod**，于是插件就有了一个运行时依赖。而 `plugin_install` 对本地
 * 路径用的是 pnpm `link:`（软链）—— Node 跟着软链回到源码目录，命中源码目录为类型检查
 * 安装的 `@deepseek-ai/*` 副本，**分裂模块身份**，插件永远停在 PENDING（M0 探针实测确认）。
 *
 * 去掉运行时依赖之后，插件包就是纯粹的 `lib/` + `package.json`，把一个**真实副本**放进
 * profile 即可运行。
 *
 * 【保留了 storageDomain 的哪些好处】
 * - **按记录落盘**：每个任务一个 JSON 文件，改一个不重写全部；
 * - **坏记录隔离**：解析失败返回 `undefined` 并上报，绝不让一条脏数据拖挂组件；
 * - **原子写**：真实实现走 `dsh-atomic-write` 的 `writeFileAtomic`；
 * - **串行写入队列**：同一任务不会被后写的旧快照覆盖。
 *
 * 【与 storageDomain 的差别】没有版本号与 `backupRecord`（自动备份坏记录）。
 */

import type { TaskStorePort } from '../runtime/orchestrator.js'
import type { InstanceInfo } from '../runtime/store.js'
import { parseTaskState, serializeTaskState } from '../runtime/store.js'
import type { TaskState } from '../runtime/task-state.js'
import { parseInstanceInfo } from './instance.js'

export const INSTANCE_FILE = 'instance.json'
export const TASKS_DIR = 'tasks'

/** 任务 id 的合法字符（与配置校验里的 kebab-case 规则一致）。 */
const TASK_ID_RE = /^[a-z0-9][a-z0-9-]*$/

/**
 * 任务状态文件的路径。
 *
 * **拒绝任何会逃出目录的 id**（`..`、`/`、空串）：虽然配置校验已经限制成 kebab-case，
 * 但存储层不该依赖上游——路径穿越是最不该省的一道检查。
 */
export function taskRecordPath(dir: string, taskId: string): string {
  if (!TASK_ID_RE.test(taskId)) {
    throw new Error(`非法任务 id ${JSON.stringify(taskId)}：只允许小写字母、数字与连字符`)
  }
  return `${dir}/${TASKS_DIR}/${taskId}.json`
}

export function instanceRecordPath(dir: string): string {
  return `${dir}/${INSTANCE_FILE}`
}

/** 文件系统能力（注入以便纯单测）。 */
export interface TaskFileStoreFs {
  read(path: string): string | undefined
  write(path: string, content: string): Promise<void>
  remove(path: string): Promise<void>
}

export interface TaskFileStore extends TaskStorePort {
  flush(): Promise<void>
  readonly failures: number
  readInstance(): InstanceInfo | undefined
  writeInstance(info: InstanceInfo): void
}

export interface FileTaskStoreOptions {
  /** 状态目录，通常是 `dshHomePath('storages', 'heartbeat')` */
  readonly dir: string
  readonly fs: TaskFileStoreFs
  readonly onError?: (taskId: string, error: unknown) => void
}

function parseJson(raw: string | undefined): unknown {
  if (raw === undefined) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return Symbol.for('dsh-heartbeat:invalid-json')
  }
}

export function createFileTaskStore(options: FileTaskStoreOptions): TaskFileStore {
  const { dir, fs, onError } = options

  let chain: Promise<void> = Promise.resolve()
  let failures = 0

  /** 串行落盘：保证同一任务的多次写入按调用顺序生效。 */
  function enqueue(taskId: string, operation: () => Promise<unknown>): void {
    chain = chain
      .then(
        () => operation().then(() => undefined),
        () => operation().then(() => undefined),
      )
      .catch((error: unknown) => {
        failures += 1
        onError?.(taskId, error)
      })
  }

  function loadRecord<T>(
    taskId: string,
    path: string,
    parse: (raw: unknown) => T | undefined,
  ): T | undefined {
    const raw = fs.read(path)
    if (raw === undefined) return undefined

    const parsed = parse(parseJson(raw))
    if (parsed === undefined) {
      // 坏记录隔离：跳过它并上报，让调用方用一个干净状态继续
      onError?.(taskId, new Error(`运行期状态记录损坏，已跳过：${path}`))
    }
    return parsed
  }

  return {
    load(taskId) {
      return loadRecord(taskId, taskRecordPath(dir, taskId), parseTaskState)
    },

    save(taskId, state: TaskState) {
      const path = taskRecordPath(dir, taskId)
      const content = `${JSON.stringify(serializeTaskState(state), null, 2)}\n`
      enqueue(taskId, () => fs.write(path, content))
    },

    remove(taskId) {
      enqueue(taskId, () => fs.remove(taskRecordPath(dir, taskId)))
    },

    async flush() {
      await chain
    },

    get failures() {
      return failures
    },

    readInstance() {
      return loadRecord('(instance)', instanceRecordPath(dir), parseInstanceInfo)
    },

    writeInstance(info: InstanceInfo) {
      const path = instanceRecordPath(dir)
      enqueue('(instance)', () => fs.write(path, `${JSON.stringify(info, null, 2)}\n`))
    },
  }
}
