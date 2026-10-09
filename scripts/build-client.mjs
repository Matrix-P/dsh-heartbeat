/**
 * 客户端 bundle 构建器（技术设计 10.6）。
 *
 * **为什么不用 esbuild / 官方 tsdown preset**：
 * - 官方仓库内的 `tsdown.client.ts` preset **没有发布到 npm**，仓库外无法复用；
 * - esbuild 在受限沙箱里会 fork 子进程（piped stdio），本项目环境直接 EPERM。
 *
 * 所以这里用「`tsc` 编成 CJS + 自写小包装器」：
 *
 * ```
 * src/client/**.tsx  ──tsc(module: commonjs)──▶  build-client/client/**.js
 *                                                      │  沿相对 require 递归收集
 *                                                      ▼
 *                                    lib/client.js（__ModuleLoader__.load 包装）
 * ```
 *
 * 裸导入（`react` / `react/jsx-runtime` 等）**不改写**，原样交给 shell 的 baseline
 * 模块表（`dsh-client-modules`）。脚本最后会**自检** bundle 能否在假 window 下加载并
 * 导出 `apply` / `inject`，避免产出"看起来能跑其实语法错"的产物。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const CJS_DIR = join(ROOT, 'build-client')
const ENTRY_ID = 'client/index.js'
const OUT_FILE = join(ROOT, 'lib', 'client.js')
/**
 * bundle 的 id **必须等于 package.json 的 name**。
 *
 * 这是 dsh-client-modules 的硬契约：宿主的模块图按**包名**建条目
 * （`reconcilePackage` 用 `resolveMeta` 得到的 packageName），
 * `__ModuleLoader__.load({ id })` 注册的 id 必须与之逐字相同。
 *
 * 曾经这里是硬编码的 `'dsh-heartbeat'`：包名改成 `@analy3939/dsh-heartbeat` 之后
 * 就错位了，桌面端直接报
 * `client-modules: duplicate factory registration for "dsh-heartbeat"`，
 * 并连带把整个 web 启动判为失败（`1 entry did not activate`）。
 * 所以改成从 package.json 读 —— 以后改名不会再漏。
 */
const PLUGIN_ID = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).name
if (typeof PLUGIN_ID !== 'string' || PLUGIN_ID === '') {
  throw new Error('package.json 缺少 name，无法确定 bundle id')
}

/** 只匹配相对导入；裸导入留给 shell。 */
const RELATIVE_REQUIRE_RE = /require\((["'])(\.[^"']*)\1\)/g

function resolveId(fromId, spec) {
  return join(dirname(fromId), spec).replaceAll('\\', '/')
}

const modules = new Map()

function collect(id) {
  if (modules.has(id)) return

  let source
  try {
    source = readFileSync(join(CJS_DIR, id), 'utf8')
  } catch {
    throw new Error(`客户端 bundle 构建失败：找不到模块 ${id}（tsc 是否已产出 build-client/？）`)
  }

  modules.set(id, source)

  for (const match of source.matchAll(RELATIVE_REQUIRE_RE)) {
    collect(resolveId(id, match[2]))
  }
}

collect(ENTRY_ID)

const defs = [...modules.entries()]
  .map(([id, source]) => `      ${JSON.stringify(id)}: function (require, module, exports) {\n${source}\n      },`)
  .join('\n')

const bundle = `/**
 * ${PLUGIN_ID} 浏览器侧 bundle —— **自动生成，请勿手改**。
 * 由 scripts/build-client.mjs 从 src/client/** 产出。
 * 模块数：${modules.size}
 */
window.__ModuleLoader__.load({
  id: ${JSON.stringify(PLUGIN_ID)},
  factory: (require) => {
    const __defs = {
${defs}
    };
    const __cache = Object.create(null);

    function __resolve(from, spec) {
      const segments = from.split('/').slice(0, -1).concat(spec.split('/'));
      const out = [];
      for (const segment of segments) {
        if (segment === '' || segment === '.') continue;
        if (segment === '..') out.pop();
        else out.push(segment);
      }
      return out.join('/');
    }

    function __requireFrom(from) {
      return (spec) => {
        // 裸导入交给 shell 的 baseline 模块表（react / react-dom / cordis / …）
        if (!spec.startsWith('.')) return require(spec);
        const target = __resolve(from, spec);
        const definition = __defs[target];
        if (definition === undefined) {
          throw new Error(${JSON.stringify(`${PLUGIN_ID}: 客户端 bundle 缺少模块 `)} + target);
        }
        return __load(target);
      };
    }

    function __load(id) {
      const cached = __cache[id];
      if (cached !== undefined) return cached.exports;
      const module = { exports: {} };
      __cache[id] = module;
      __defs[id](__requireFrom(id), module, module.exports);
      return module.exports;
    }

    return __load(${JSON.stringify(ENTRY_ID)});
  },
});
`

mkdirSync(dirname(OUT_FILE), { recursive: true })
writeFileSync(OUT_FILE, bundle, 'utf8')

/** 自检：在假 window 下加载 bundle，确认导出形态正确。 */
function verify() {
  const loaded = []
  const fakeWindow = {
    __ModuleLoader__: {
      load: (definition) => {
        loaded.push(definition)
      },
    },
  }

  const shellModules = {
    react: {
      createElement: () => null,
      useCallback: (fn) => fn,
      useEffect: () => undefined,
      useMemo: (fn) => fn(),
      useState: (initial) => [initial, () => undefined],
    },
    'react/jsx-runtime': { jsx: () => null, jsxs: () => null, Fragment: null },
  }

  // eslint-disable-next-line no-new-func
  const run = new Function('window', bundle)
  run(fakeWindow)

  if (loaded.length !== 1) throw new Error(`期望注册 1 个模块，实际 ${loaded.length}`)
  const definition = loaded[0]
  if (definition.id !== PLUGIN_ID) throw new Error(`模块 id 不符：${definition.id}`)

  const exportsObject = definition.factory((spec) => {
    if (Object.hasOwn(shellModules, spec)) return shellModules[spec]
    throw new Error(`bundle 请求了未在 baseline 里的模块：${spec}`)
  })

  if (typeof exportsObject.apply !== 'function') throw new Error('bundle 未导出 apply 函数')
  if (!Array.isArray(exportsObject.inject)) throw new Error('bundle 未导出 inject 数组')
  if (typeof exportsObject.name !== 'string') throw new Error('bundle 未导出 name')

  return { moduleCount: modules.size, inject: exportsObject.inject, name: exportsObject.name }
}

const result = verify()
console.log(
  `✓ lib/client.js 已生成：${result.moduleCount} 个模块、id=${PLUGIN_ID}、name=${result.name}、inject=[${result.inject.join(', ')}]`,
)
