/**
 * 心跳配置的**自有存储** —— 任务定义存在我们自己的文件里：
 *
 * ```
 * $DSH_HOME/storages/heartbeat/config.json     ← 本模块
 * $DSH_HOME/storages/heartbeat/tasks/*.json    ← 运行期任务快照（已有的 file-store）
 * $DSH_HOME/storages/heartbeat/instance.json   ← 单实例锁
 * ```
 *
 * 【为什么不用框架的配置层】0.2.0 把配置改成「Loader 行自己的 config」，而桌面端的
 * profile 文档是**受管的**（实测：插件条目可见但没有任何配置操作 ✗），框架侧根本写不进去。
 * 所以任务定义改由我们自己管：
 *
 * - 两代行为完全一致 ✓
 * - 写入路径不依赖任何框架服务 ✓
 * - 界面（设置分区）通过 `GET/POST /api/heartbeat/config` 读写它 ✓
 *
 * 读失败（文件不存在/损坏/权限）一律返回 `undefined` 并交给调用方回落 ——
 * **绝不让配置读取阻断插件启动**。
 */

import { readFileSync, renameSync, writeFileSync } from 'node:fs'

import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

/** 配置文件名（与运行期任务快照同目录）。 */
export const CONFIG_FILE_NAME = 'config.json'

/** 取配置文件绝对路径。 */
export function configFilePath(): string {
  return dshHomePath('storages', 'heartbeat', CONFIG_FILE_NAME)
}

/**
 * 读取自有存储里的配置。拿不到就返回 `undefined`（调用方回落到框架 config）。
 */
export function readStoredConfig(): unknown {
  try {
    return JSON.parse(readFileSync(configFilePath(), 'utf8')) as unknown
  } catch {
    return undefined
  }
}

/**
 * 原子写入配置：先写同目录临时文件再 `renameSync` 覆盖 ——
 * 避免写一半被打断留下半个文件（任务定义丢了比没生效更糟 ✗）。
 */
export function writeStoredConfig(value: unknown): void {
  const target = configFilePath()
  const temporary = `${target}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(temporary, target)
}
