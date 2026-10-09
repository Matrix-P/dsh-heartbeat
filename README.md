# dsh-heartbeat · DSH 心跳

> 让 DeepSeek Harness 按你定的时间，**主动来跟你说话**。

`dsh-heartbeat` 是给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的**定时任务组件**：按时间规则，向**你指定的那个会话**投递一条**你自己写的**提示。最终说什么，由那个会话的主 Agent 结合上下文和人设自己发挥。

```
你写：  早上好呀，看看 {weekday} 的日程，用你平时的语气跟我说句话
DSH 收到：「早上好呀，看看周一的日程，用你平时的语气跟我说句话」
目标会话的 Agent 结合上下文生成真正的回复 → 你收到一条消息
```

---

## 它和别的定时插件有什么不一样

| | |
| --- | --- |
| **模型说话期间不计时** | 下一次触发从「模型这次输出结束」那一刻重新起算。输出中不会被心跳打断，也不会因为回复耗时长而让计时漂移。 |
| **投给谁由你定** | 指定任意**根会话**（含 IM 渠道会话）。子 Agent 会话会被自动过滤掉 —— 心跳只找「主 Agent」。 |
| **文案权留给你和那个人设** | 插件只投递你写的提示，**不预设任何固定回复**。目标会话的 Agent 用自己的性格说话。 |
| **可视化设置界面** | 设置 → 心跳：任务列表、下次触发时间、已触发次数、无回应次数、立即触发一次、新建/编辑/删除。中英双语。 |
| **零运行时依赖** | 只依赖 DSH 官方包（`peerDependencies`）与 Node 内置模块。没有第三方运行时依赖。 |

---

## 安装

```sh
dsh plugin add dsh-heartbeat --profile web
```

因为包内声明了 `dsh.bundle`，`dsh` 会把它追加进 profile 的 `dsh.profile.bundles` 并自动应用配置层。**装完需要重启一次 DSH web**（新增插件行不会热加载）。

<details>
<summary>其他安装方式</summary>

```sh
# 从 GitHub 源码安装（需要额外给 pnpm 授权构建脚本）
dsh plugin add github:<你的账号>/dsh-heartbeat --profile web

# 从本地 tarball 安装
pnpm pack
dsh plugin add ./dsh-heartbeat-0.1.0.tgz --profile web
```

要求：DSH **`0.1.5-rc.2` 或 `0.2.0-rc.2`**（两代都支持：配置通道在运行时探测 `settings.register` —— 有就走 0.1.x 的命名空间热更新，没有就用 0.2.x 的 Loader 行 Config）、Node ≥ 20、Web 系 profile（桌面端也是 Web 系）。

> **0.2.x 上的两点差异**：0.2.0 移除了共享的 `plugin` 消息来源 kind，也移除了配置写前校验钩子。因此（1）心跳提示在 0.2.x 上按"未知来源"降级呈现；（2）配置问题通过 `/api/heartbeat/state` 的 `warnings` 暴露，而不是在保存时被直接拒绝。

</details>

---

## 快速开始

1. 打开 **设置 → 心跳**，勾选「启用组件」；
2. 点「新建任务」；
3. 填 **名称**、选 **目标会话**（下拉列出了你的所有根会话和它们的标题）、写 **提示文案**；
4. 选时间规则 → 保存。

任务立刻生效。列表里能看到状态、下次触发时间、已触发次数、连续无回应次数，也可以「立即触发」一次来验证链路。

---

## 时间规则

| 类型 | `type` | 说明 | 主要字段 |
| --- | --- | --- | --- |
| 一次性 | `once` | 某个日期时刻触发一次 | `at` |
| 每天 | `daily` | 每天固定时刻 | `at` |
| 每周 | `weekly` | 每周指定日 + 时刻 | `at`、`days` |
| 固定间隔 | `interval` | 每 N 分钟/小时触发 | `every`、`anchor` |
| 窗口内固定间隔 | `windowed-interval` | 只在每天的时间窗口内按间隔触发 | `every`、`window`、`align` |

- **生效日**（`weekly`）：每天 / 工作日 / 周末 / 自定义。
- **计时起点**（`interval`）：`enable-time` 从启用时刻起算，或 `interval-end` 每次触发后重新计时。
- **窗口内对齐**（`windowed-interval`）：以窗口起点对齐，或从启用时刻对齐。
- 时长写法：`30s`、`15m`、`2h`、`1d`，也可以组合。

配置最终落在 `settings.yaml`：

```yaml
heartbeat:
  tasks:
    - id: task-1
      name: 早安
      session: <sessionId>
      schedule:
        type: interval
        every: 1m
        anchor: interval-end
      payload:
        kind: prompt
        text: 早上好呀，用你平时的语气跟我说句话
      noReply:
        max: 3
```

---

## 提示文案里的占位符

在文案里写 `{名字}` 即可，触发时求值。带参数的写 `{time:HH:mm}`，方括号可转义字面量（`[`、`]`）。

| 占位符 | 默认参数 | 含义 |
| --- | --- | --- |
| `{time}` | `HH:mm` | 当前时刻 |
| `{date}` | `YYYY-MM-DD` | 当前日期 |
| `{datetime}` | `YYYY-MM-DD HH:mm` | 当前日期与时间 |
| `{weekday}` | — | 星期几（周一…周日） |
| `{taskId}` | — | 任务 ID |
| `{taskName}` | — | 任务展示名 |
| `{fireCount}` | — | 含本次在内的累计触发次数 |
| `{noReplyStreak}` | — | 当前连续无回应次数 |
| `{lastFiredAt}` | `YYYY-MM-DD HH:mm` | 上次触发时间 |
| `{nextFireAt}` | `YYYY-MM-DD HH:mm` | 下次计划触发时间 |
| `{sinceLastUserMsg}` | — | 距用户上次发言的时长 |
| `{lastUserMsgAt}` | `YYYY-MM-DD HH:mm` | 用户上次发言时刻 |
| `{random}` | `1-100` | 随机整数（可指定范围，如 `{random:1-6}`） |

例：`{weekday} {time:HH:mm} 了，{sinceLastUserMsg} 没找我说话了，{random:1-3} 句话哄哄我`

---

## 投递策略

| 字段 | 取值 | 说明 |
| --- | --- | --- |
| `onBusy` | `queue`（默认）/ `skip` / `inject` | 目标会话正忙（模型在输出）时：排队等这轮结束 / 跳过本次 / 立刻插进去 |
| `missed` | `skip`（默认）/ `fire-once` | 进程重启或机器休眠期间错过的触发：跳过 / 补发一次 |
| `noReply.max` | 数字，`0` = 关闭 | 连续 N 次没有回应就暂停这个任务（静默），不再打扰你 |
| `noReply.window` | 时长，留空 = 到下次触发前 | 判定「有没有回应」的时间窗 |

被静默的任务会显示「暂停」状态，界面上可以直接重新启用。

---

## 状态与接口

组件把**运行期状态**（下次触发、触发次数、无回应次数、静默原因）通过只读 HTTP 暴露，**不写进 `settings.yaml`**，免得把配置文档弄脏：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/heartbeat/state` | 全部任务的运行期状态 |
| `GET` | `/api/heartbeat/sessions` | 可投递的会话候选（已过滤子会话） |
| `POST` | `/api/heartbeat/fire` | 立即触发一次（仅限本机请求），body `{"id":"<taskId>"}` |

状态目录：`$DSH_HOME/storages/heartbeat/`（每个任务一个 JSON，原子写）。

---

## 试出来的坑（给插件开发者的三条经验）

这个组件在真实 DSH 里调试时踩到几个只在运行时才暴露的坑，挑三条最值钱的：

1. **`link:` 安装会分裂模块身份** —— 插件里的 `@deepseek-ai/*` 会解析到源码目录自己的副本，于是 `inject` 的服务永远解析不到，fiber 静静停在 `PENDING`。用真实副本 / npm 安装。
2. **直读一个没有 `inject` 的服务会抛异常**（不是返回 `undefined`）——`(ctx as {x?: T}).x` 这种"可选直读"会让 `apply` 直接抛，插件整个不加载。正确写法是 `ctx.get(name)` + `ctx.inject([name], cb)`。
3. **`settings.section` 的 owner 只传 `close` 一个 prop** —— 分区组件的 `scope`/`t`/数据都要靠注册时闭包带进去，直接注册裸组件会拿到一堆 `undefined`。

另外：客户端插槽所在的 Loader 行，**行名必须与 `package.json` 的 `name` 完全一致**，否则客户端半边不会被扫描到（宿主正常、界面永远不出现）。

---

## 开发

```sh
pnpm install
pnpm test        # 24 个测试文件 / 521 个用例
pnpm typecheck
pnpm build       # ESM → lib/，客户端 bundle → lib/client.js
```

- `src/schedule/` 时间规则（时长、时区、日历、下次触发推导）
- `src/templating/` 占位符解析与求值
- `src/runtime/` 状态机、时钟 seam、单 timer 调度器、编排器、持久化
- `src/delivery/` 投递端口（**只给主 Agent** 这条约束在这里）
- `src/host/` 唯一直接接触 `@deepseek-ai/*` 的胶水层
- `src/client/` 设置界面（纯逻辑与 React 组件分离）

---

## English

`dsh-heartbeat` is a scheduling component for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): on your schedule, it delivers **a prompt you wrote** to **a session you pick**, and that session's main agent answers in its own voice, with full context.

Highlights:

- **Output-aware timing** — the next fire is counted from the moment the model *finishes* its output, not from the trigger. Heartbeats never interrupt an in-flight reply, and long answers don't drift the schedule.
- **You choose the target** — any root session, including IM channels. Subagent sessions are filtered out; heartbeats only talk to a main agent.
- **The text is yours** — the plugin delivers your prompt (13 `{placeholders}` supported) and leaves the wording to the target agent's persona.
- **Visual settings UI** — task list, next fire time, fire count, no-reply streak, fire-now button, create/edit/delete. Bilingual (中文 / English).
- **Zero runtime dependencies** — DSH official packages as peer dependencies plus Node built-ins.

```sh
dsh plugin add dsh-heartbeat --profile web
```

Requires DSH `0.1.5-rc.2`+, Node ≥ 20, and a Web-family profile.

## License

MIT
