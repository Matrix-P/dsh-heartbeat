/**
 * 浏览器侧入口（技术设计 10.3）。
 *
 * 这个文件只做三件事：注册词表、绑定配置通道、**通过 `settings.section` 插槽**
 * 注册设置分区。界面本体在 `section.tsx`。
 *
 * 【为什么必须走 `slots.inject`】`settings.section` 是 `ui-settings-general` 在运行时
 * 动态声明的插槽，激活顺序不受约束；直接 `register` 会抛
 * `slot "..." is not declared`（`dsh-client-ui-settings-general lib/client.js:516-519`）。
 *
 * 【类型说明】客户端 ctx 上的 `slots` / `locale` / `settingsScope` 由三个**客户端包**
 * （`dsh-client-ui-renderer` / `dsh-client-locale` / `dsh-client-ui-settings`）做
 * 模块增强，它们被打进 Web shell、不在插件依赖里。因此这里按官方 .d.ts 的签名声明
 * **结构化最小接口**；真实的 ctx 在结构上满足它们。
 */

import { createElement } from 'react'

import type { SessionPayload, SettingsScopeLike } from './section.js'
import { HeartbeatSection, SESSIONS_PATH } from './section.js'

export const name = 'heartbeat-client'

export const inject = ['slots', 'locale', 'settingsScope']

/** 本地化命名空间（必须匹配 `/^[a-z][a-z0-9-]*$/` 的变体）。 */
export const LOCALE_NS = 'heartbeat'

/** 与 host 侧 `settings.register(NAMESPACE, …)` 的命名空间必须一致。 */
export const SETTINGS_NAMESPACE = 'heartbeat'

export const SECTION_SLOT = 'settings.section'

/** 设置分区在导航里的排序位置。 */
export const SECTION_ORDER = 50

export interface SectionSlotOptions {
  readonly name: string
  readonly id: string
  readonly order?: number
  readonly label?: string | (() => string)
  readonly locale?: string
}

export interface ClientSlots {
  inject(key: string, callback: () => unknown): unknown
  register(options: SectionSlotOptions, component: unknown): unknown
}

export interface ClientLocale {
  register(namespaceName: string, dictionaries: Record<string, Record<string, string>>): unknown
  bind(namespaceName: string): (key: string) => string
}

export interface SettingsScopeSpec {
  readonly namespace: string
}

export interface ClientSettingsScope {
  bind(spec: SettingsScopeSpec): unknown
}

export interface ClientContext {
  readonly slots: ClientSlots
  readonly locale: ClientLocale
  readonly settingsScope: ClientSettingsScope
  effect(callback: () => unknown, label?: string): unknown
}

/**
 * 词表。中英两份的 key 集合必须完全一致（有测试守着，防止漏翻）。
 */
export const DICTIONARIES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  zh: {
    nav: '心跳',
    title: '心跳定时任务',
    subtitle: '按时间规则，让 DSH 主动来找你说话',
    loading: '正在读取状态…',
    stateUnavailable: '运行期状态暂时取不到（配置仍可正常编辑）',
    empty: '还没有定时任务',
    addTask: '新建任务',
    edit: '编辑',
    done: '完成',
    cancel: '取消',
    save: '保存',
    remove: '删除',
    confirmRemove: '确定删除这个任务？',
    enable: '启用',
    enabled: '启用组件',
    disable: '停用',
    fireNow: '立即触发',
    fired: '已触发一次',
    status: '状态',
    nextFire: '下次触发',
    lastFire: '上次触发',
    fireCount: '已触发',
    noReply: '无回应',
    taskId: '任务 ID',
    taskName: '名称',
    session: '目标会话',
    sessionPlaceholder: '请选择会话',
    timezone: '时区（留空继承全局）',
    scheduleType: '时间规则',
    once: '一次性',
    daily: '每天',
    weekly: '每周',
    interval: '固定间隔',
    windowedInterval: '窗口内固定间隔',
    at: '时刻',
    atDate: '日期与时刻',
    days: '生效日',
    daysAll: '每天',
    daysWorkdays: '工作日',
    daysWeekends: '周末',
    daysCustom: '自定义',
    every: '间隔',
    anchor: '计时起点',
    anchorEnable: '从启用时刻起',
    anchorIntervalEnd: '每次触发后重新计时',
    window: '时间窗口',
    windowStart: '开始',
    windowEnd: '结束',
    align: '窗口内对齐',
    alignWindowStart: '以窗口起点对齐',
    alignEnableTime: '以启用时刻对齐',
    onBusy: '忙碌时',
    onBusyQueue: '排队（默认）',
    onBusySkip: '跳过',
    onBusyInject: '立即注入',
    missed: '错过补偿',
    missedSkip: '跳过（默认）',
    missedFireOnce: '补发一次',
    noReplyMax: '无回应静默上限（0 = 关闭）',
    noReplyWindow: '回应判定窗口（留空 = 到下次触发前）',
    payloadText: '触发时投递的提示文案',
    payloadHint: '支持 {} 占位符；最终消息由目标会话的主 Agent 结合上下文生成',
    insertPlaceholder: '插入占位符',
    issuesTitle: '配置有问题，已保留上一次生效的配置',
    unnamed: '(未命名会话)',
    imBadge: 'IM 会话',
  },
  en: {
    nav: 'Heartbeat',
    title: 'Heartbeat schedules',
    subtitle: 'Let DSH reach out to you on your own schedule',
    loading: 'Loading state…',
    stateUnavailable: 'Runtime state is unavailable right now (configuration is still editable)',
    empty: 'No schedules yet',
    addTask: 'New schedule',
    edit: 'Edit',
    done: 'Done',
    cancel: 'Cancel',
    save: 'Save',
    remove: 'Remove',
    confirmRemove: 'Remove this schedule?',
    enable: 'Enable',
    enabled: 'Enable component',
    disable: 'Disable',
    fireNow: 'Fire now',
    fired: 'Fired once',
    status: 'Status',
    nextFire: 'Next fire',
    lastFire: 'Last fire',
    fireCount: 'Fires',
    noReply: 'No reply',
    taskId: 'Task ID',
    taskName: 'Name',
    session: 'Target session',
    sessionPlaceholder: 'Pick a session',
    timezone: 'Timezone (blank inherits global)',
    scheduleType: 'Schedule',
    once: 'One-shot',
    daily: 'Daily',
    weekly: 'Weekly',
    interval: 'Interval',
    windowedInterval: 'Interval within a window',
    at: 'Time',
    atDate: 'Date and time',
    days: 'Days',
    daysAll: 'Every day',
    daysWorkdays: 'Weekdays',
    daysWeekends: 'Weekends',
    daysCustom: 'Custom',
    every: 'Every',
    anchor: 'Anchor',
    anchorEnable: 'From enable time',
    anchorIntervalEnd: 'Restart after each fire',
    window: 'Window',
    windowStart: 'Start',
    windowEnd: 'End',
    align: 'Alignment',
    alignWindowStart: 'Align to window start',
    alignEnableTime: 'Align to enable time',
    onBusy: 'When busy',
    onBusyQueue: 'Queue (default)',
    onBusySkip: 'Skip',
    onBusyInject: 'Inject now',
    missed: 'Missed fires',
    missedSkip: 'Skip (default)',
    missedFireOnce: 'Fire once',
    noReplyMax: 'Auto-suspend after (0 = off)',
    noReplyWindow: 'Reply window (blank = until next fire)',
    payloadText: 'Prompt delivered on fire',
    payloadHint: 'Placeholders in {} are supported; the session agent writes the final message',
    insertPlaceholder: 'Insert placeholder',
    issuesTitle: 'Configuration has problems; the last working config is still in effect',
    unnamed: '(unnamed session)',
    imBadge: 'IM session',
  },
}

export function apply(ctx: ClientContext): void {
  ctx.effect(
    () => ctx.locale.register(LOCALE_NS, DICTIONARIES as Record<string, Record<string, string>>),
    'heartbeat:locale',
  )

  const t = ctx.locale.bind(LOCALE_NS)
  const scope = ctx.settingsScope.bind({ namespace: SETTINGS_NAMESPACE }) as SettingsScopeLike

  /**
   * 会话候选走 host 的只读通道（设计 10.2 / 10.5）。
   * 拿不到就返回空列表 —— 组件会自动退化成"手填会话 id"。
   */
  const loadSessions = async (): Promise<SessionPayload> => {
    const response = await fetch(SESSIONS_PATH, { headers: { accept: 'application/json' } })
    if (!response.ok) return { candidates: [] }
    return (await response.json()) as SessionPayload
  }

  /**
   * 【必须包装，别退回直接注册裸组件】`settings.section` 的 owner **只传 `close` 一个 prop**
   * （官方 `SettingsSectionOwnerProps`；`dsh-client-ui-settings-general lib/client.js:167`
   * 就是 `renderSlot("settings.section", { close: onClose }, …)`）。
   *
   * 分区自己的数据必须靠**注册时的闭包**带进去。直接注册 `HeartbeatSection` 的话，
   * `scope` / `t` / `loadSessions` 全是 `undefined`：界面会永远停在"正在读取状态…"，
   * 目标会话也永远只能手填 —— 这正是 M0 探针里实际出现的那两个现象。
   */
  ctx.slots.inject(SECTION_SLOT, () =>
    ctx.slots.register(
      {
        name: SECTION_SLOT,
        id: 'heartbeat',
        order: SECTION_ORDER,
        // 用函数形式，语言切换后重新取值
        label: () => t('nav'),
        locale: LOCALE_NS,
      },
      () => createElement(HeartbeatSection, { scope, t, loadSessions }),
    ),
  )
}
