/**
 * 设置分区主组件（技术设计 10.4 / 12.3 / 12.4）。
 *
 * 数据来源分工：
 * - **配置**：`ctx.settingsScope`（走 `settings.yaml`，支持热加载）
 * - **运行期状态**：`GET /api/heartbeat/state`（`nextFireAt` / 计数 / 静默原因）
 *
 * 这里刻意保持"薄"：所有可测逻辑都在 `view-model.ts` / `session-picker.ts` / `form.ts`
 * 里，本文件负责把数据接上控件、把交互接回 `settingsScope`。
 */

import { createElement, useCallback, useEffect, useMemo, useState } from 'react'
import type { FunctionComponent, ReactElement, ReactNode } from 'react'

// 只声明用到的浏览器全局：本包不开 `DOM` lib，避免服务端代码被浏览器类型污染
declare const window: { confirm(message?: string): boolean }

import type { ConfigIssue } from '../config.js'
import type { TaskSnapshot } from '../runtime/orchestrator.js'
import type { TaskForm } from './form.js'
import { groupIssuesByTask, newTaskForm, switchScheduleType, toRawTask, toTaskForm } from './form.js'
import { toSessionOptions } from './session-picker.js'
import type { TaskRowView } from './view-model.js'
import { toTaskRowView } from './view-model.js'

/** 与 host 侧 `STATE_PATH` 保持一致。 */
export const STATE_PATH = '/api/heartbeat/state'

/** 会话候选接口；与 host 侧 `SESSIONS_PATH` 保持一致。 */
export const SESSIONS_PATH = '/api/heartbeat/sessions'

/**
 * 主题 token。
 *
 * 【血泪】DSH 设计系统的变量名是 **`--dsw-alias-*`**（深色主题挂在
 * `body[data-ds-dark-theme]` 上）；出处 `dsh-client-ui-theme lib/client.js:1053,1135-1194`。
 * 之前这里写的是想当然的 `--dsh-border`，那个变量**根本不存在**，所以永远走 fallback ——
 * 深色模式下就表现为"只有鼠标悬停的那一项看得见"。
 *
 * 两条纪律：
 * 1. **不要写死颜色**，一律走 token；
 * 2. 每个 token 都带 fallback，token 万一改名界面还能看，不至于变成透明。
 */
const TOKEN = {
  labelPrimary: 'var(--dsw-alias-label-primary, inherit)',
  labelSecondary: 'var(--dsw-alias-label-secondary, currentColor)',
  border: 'var(--dsw-alias-border-l2, rgba(128,128,128,.35))',
  fieldBg: 'var(--dsw-alias-bg-layer-1, rgba(128,128,128,.08))',
  popupBg: 'var(--dsw-alias-bg-overlay, rgba(128,128,128,.12))',
  danger: 'var(--dsw-alias-label-error, #e5534b)',
} as const

/**
 * 表单控件统一样式。
 *
 * **`background` 不能是 `transparent`**：`<select>` 弹出的下拉层背景取的是 select
 * 自己的背景色，透明时浏览器会画成白色，而选项文字是继承来的浅色 —— 深色模式下
 * 整列选项都看不见，只有鼠标悬停那一项被高亮出来才看得见。
 */
const inputStyle = {
  padding: '4px 6px',
  border: `1px solid ${TOKEN.border}`,
  borderRadius: '6px',
  background: TOKEN.fieldBg,
  color: TOKEN.labelPrimary,
} as const

/** 下拉选项也显式给一次颜色：个别浏览器弹出的下拉层不吃 select 的背景。 */
const optionStyle = {
  background: TOKEN.popupBg,
  color: TOKEN.labelPrimary,
} as const

/** 按钮统一样式（不写死颜色，深色模式才跟着走）。 */
const buttonStyle = {
  padding: '4px 10px',
  border: `1px solid ${TOKEN.border}`,
  borderRadius: '6px',
  background: TOKEN.fieldBg,
  color: TOKEN.labelPrimary,
  cursor: 'pointer',
} as const

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const

export interface SettingsScopeSnapshot {
  readonly status: string
  readonly value?: {
    readonly enabled?: boolean
    readonly tasks?: readonly unknown[]
  }
  readonly writable?: boolean
}

/** `ctx.settingsScope.bind(...)` 的最小结构（官方 `SettingsScope`）。 */
export interface SettingsScopeLike {
  getSnapshot(): SettingsScopeSnapshot
  subscribe(listener: () => void): () => void
  set(field: string, value: unknown): Promise<void>
}

export interface StatePayload {
  readonly now: number
  readonly tasks: readonly TaskSnapshot[]
  readonly warnings?: readonly ConfigIssue[]
}

export interface SessionPayload {
  readonly candidates?: readonly { sessionId: string; title: string | null; kind: string; updatedAt: number }[]
}

export interface HeartbeatSectionProps {
  readonly scope?: SettingsScopeLike
  readonly t?: (key: string) => string
  readonly close?: () => void
  /** 会话候选由 host 的会话列表接口提供；取不到时退化为"手填会话 id" */
  readonly loadSessions?: () => Promise<SessionPayload>
}

type Translate = (key: string) => string

const FALLBACK_T: Translate = (key) => key

function useSnapshot(scope: SettingsScopeLike | undefined): SettingsScopeSnapshot {
  const [snapshot, setSnapshot] = useState<SettingsScopeSnapshot>(
    scope?.getSnapshot() ?? { status: 'unavailable' },
  )

  useEffect(() => {
    if (scope === undefined) return undefined
    setSnapshot(scope.getSnapshot())
    return scope.subscribe(() => {
      setSnapshot(scope.getSnapshot())
    })
  }, [scope])

  return snapshot
}

function usePolledState(enabled: boolean): StatePayload | null {
  const [payload, setPayload] = useState<StatePayload | null>(null)

  useEffect(() => {
    if (!enabled) return undefined
    let alive = true

    const tick = async (): Promise<void> => {
      try {
        const response = await fetch(STATE_PATH, { headers: { accept: 'application/json' } })
        if (!response.ok) return
        const body = (await response.json()) as StatePayload
        if (alive) setPayload(body)
      } catch {
        // 状态取不到不影响配置编辑，静默降级
      }
    }

    void tick()
    const handle = setInterval(() => {
      void tick()
    }, 5_000)

    return () => {
      alive = false
      clearInterval(handle)
    }
  }, [enabled])

  return payload
}

const rowStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  padding: '8px 0',
  borderBottom: `1px solid ${TOKEN.border}`,
} as const

const badgeTone: Readonly<Record<string, string>> = {
  ok: '#2da44e',
  muted: '#8b949e',
  warn: '#bf8700',
  danger: '#cf222e',
  done: '#0969da',
}

function Badge(props: { view: TaskRowView['status'] }): ReactElement | null {
  const view = props.view
  return createElement(
    'span',
    {
      style: {
        fontSize: '12px',
        padding: '1px 6px',
        borderRadius: '10px',
        color: '#fff',
        background: badgeTone[view.tone] ?? '#8b949e',
      },
    },
    view.label,
  )
}

const Field: FunctionComponent<{ label: string; children?: ReactNode }> = (props) => {
  return createElement(
    'label',
    { style: { display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '13px' } },
    createElement('span', { style: { opacity: 0.7 } }, props.label),
    props.children,
  )
}

export const HeartbeatSection: FunctionComponent<HeartbeatSectionProps> = (props) => {
  const t = props.t ?? FALLBACK_T
  const snapshot = useSnapshot(props.scope)
  const state = usePolledState(snapshot.status === 'ready')

  const rawTasks = useMemo<readonly unknown[]>(
    () => snapshot.value?.tasks ?? [],
    [snapshot.value],
  )

  const [editing, setEditing] = useState<{ index: number; form: TaskForm } | null>(null)
  const [issues, setIssues] = useState<readonly ConfigIssue[]>([])
  const [sessions, setSessions] = useState<readonly { sessionId: string; label: string; sublabel: string; badge: string | null }[]>([])

  useEffect(() => {
    if (props.loadSessions === undefined) return undefined
    let alive = true
    void props
      .loadSessions()
      .then((payload) => {
        if (!alive) return
        setSessions(
          toSessionOptions(
            (payload.candidates ?? []).map((candidate) => ({
              sessionId: candidate.sessionId,
              title: candidate.title,
              kind: candidate.kind as 'root' | 'subagent' | 'plugin-channel',
              updatedAt: candidate.updatedAt,
            })),
            Date.now(),
          ),
        )
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
    // 依赖**函数本身**，不是 `props`：`props` 每次渲染都是新对象，
    // 用 `[props]` 会让状态轮询（5s 一次 setState）每次都重新拉一遍会话列表
  }, [props.loadSessions])

  const rows = useMemo(() => {
    const now = state?.now ?? Date.now()
    const byId = new Map((state?.tasks ?? []).map((task) => [task.id, task]))
    return rawTasks.map((raw, index) => {
      const form = toTaskForm(raw)
      const id = form?.id ?? `#${index + 1}`
      const live = byId.get(id)
      return {
        index,
        id,
        form,
        row:
          live === undefined
            ? null
            : toTaskRowView(live, now, form?.noReplyMax ?? 3),
      }
    })
  }, [rawTasks, state])

  const issueGroups = useMemo(() => groupIssuesByTask(issues), [issues])

  const writeTasks = useCallback(
    async (tasks: readonly unknown[]) => {
      if (props.scope === undefined) return
      try {
        await props.scope.set('tasks', tasks)
        setIssues([])
      } catch (error) {
        setIssues([{ path: 'tasks', message: error instanceof Error ? error.message : String(error) }])
      }
    },
    [props.scope],
  )

  const saveEditing = useCallback(async () => {
    if (editing === null) return
    const next = [...rawTasks]
    next[editing.index] = toRawTask(editing.form)
    await writeTasks(next)
    setEditing(null)
  }, [editing, rawTasks, writeTasks])

  const toggleTask = useCallback(
    async (index: number, enabled: boolean) => {
      const form = toTaskForm(rawTasks[index])
      if (form === null) return
      const next = [...rawTasks]
      next[index] = toRawTask({ ...form, enabled })
      await writeTasks(next)
    },
    [rawTasks, writeTasks],
  )

  const removeTask = useCallback(
    async (index: number) => {
      if (!window.confirm(t('confirmRemove'))) return
      const next = rawTasks.filter((_, position) => position !== index)
      await writeTasks(next)
    },
    [rawTasks, t, writeTasks],
  )

  const fireNow = useCallback(async (id: string) => {
    try {
      await fetch('/api/heartbeat/fire', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id }),
      })
    } catch {
      // 触发失败由状态列表体现，这里不额外打扰
    }
  }, [])

  const children: ReactNode[] = []

  children.push(
    createElement(
      'div',
      { key: 'header', style: { marginBottom: '12px' } },
      createElement('h2', { style: { margin: '0 0 4px', fontSize: '16px' } }, t('title')),
      createElement('p', { style: { margin: 0, opacity: 0.65, fontSize: '13px' } }, t('subtitle')),
    ),
  )

  if (snapshot.status !== 'ready') {
    children.push(
      createElement('p', { key: 'loading', style: { opacity: 0.7 } }, t('loading')),
    )
  }

  if (props.scope !== undefined && snapshot.status === 'ready') {
    children.push(
      createElement(
        'label',
        { key: 'global', style: { display: 'flex', gap: '6px', alignItems: 'center', marginBottom: '12px' } },
        createElement('input', {
          type: 'checkbox',
          checked: snapshot.value?.enabled !== false,
          onChange: (event: { target: { checked: boolean } }) => {
            void props.scope?.set('enabled', event.target.checked)
          },
        }),
        createElement('span', null, t('enabled')),
      ),
    )
  }

  if (state === null && snapshot.status === 'ready') {
    children.push(
      createElement('p', { key: 'no-state', style: { opacity: 0.6, fontSize: '12px' } }, t('stateUnavailable')),
    )
  }

  children.push(
    createElement(
      'div',
      { key: 'issues' },
      ...issues.map((issue, index) =>
        createElement(
          'p',
          { key: `issue-${index}`, style: { color: TOKEN.danger, fontSize: '12px', margin: '2px 0' } },
          `${issue.path || '(root)'}：${issue.message}`,
        ),
      ),
    ),
  )

  if (rows.length === 0) {
    children.push(createElement('p', { key: 'empty', style: { opacity: 0.6 } }, t('empty')))
  }

  for (const item of rows) {
    const rowIssues = issueGroups.get(item.index) ?? []
    children.push(
      createElement(
        'div',
        { key: `row-${item.index}`, style: rowStyle },
        createElement('strong', { style: { minWidth: '120px' } }, item.form?.name || item.id),
        item.row === null
          ? createElement('span', { style: { opacity: 0.5, fontSize: '12px' } }, '—')
          : createElement(Badge, { view: item.row.status }),
        createElement(
          'span',
          { style: { fontSize: '12px', opacity: 0.75, flex: 1 } },
          item.row === null
            ? ''
            : `${t('nextFire')} ${item.row.nextFireText} · ${t('fireCount')} ${item.row.fireCountText} · ${t('noReply')} ${item.row.noReplyText}`,
        ),
        rowIssues.length > 0
          ? createElement('span', { style: { color: TOKEN.danger, fontSize: '12px' } }, `⚠ ${rowIssues.length}`)
          : null,
        createElement(
          'button',
          {
            type: 'button',
            onClick: () => {
              if (item.form !== null) setEditing({ index: item.index, form: item.form })
            },
          },
          t('edit'),
        ),
        createElement(
          'button',
          { type: 'button', style: buttonStyle, onClick: () => void fireNow(item.id) },
          t('fireNow'),
        ),
        createElement(
          'button',
          {
            type: 'button',
            onClick: () => void toggleTask(item.index, item.form?.enabled === false),
          },
          item.form?.enabled === false ? t('enable') : t('disable'),
        ),
        createElement(
          'button',
          { type: 'button', style: buttonStyle, onClick: () => void removeTask(item.index) },
          t('remove'),
        ),
      ),
    )

    if (item.row?.notice !== null && item.row?.notice !== undefined) {
      children.push(
        createElement(
          'p',
          { key: `notice-${item.index}`, style: { margin: '0 0 8px', fontSize: '12px', opacity: 0.8 } },
          item.row.notice,
        ),
      )
    }
  }

  children.push(
    createElement(
      'div',
      { key: 'actions', style: { marginTop: '12px' } },
      createElement(
        'button',
        {
          type: 'button',
          onClick: () => {
            const form = newTaskForm(rows.map((item) => item.id))
            setEditing({ index: rawTasks.length, form })
          },
        },
        t('addTask'),
      ),
    ),
  )

  if (editing !== null) {
    children.push(
      createElement(TaskEditor, {
        key: 'editor',
        t,
        form: editing.form,
        sessions,
        onChange: (form: TaskForm) => setEditing({ ...editing, form }),
        onCancel: () => setEditing(null),
        onSave: () => void saveEditing(),
      }),
    )
  }

  return createElement('div', { style: { padding: '4px 2px' } }, ...children)
}

interface TaskEditorProps {
  readonly t: Translate
  readonly form: TaskForm
  readonly sessions: readonly { sessionId: string; label: string; sublabel: string; badge: string | null }[]
  readonly onChange: (form: TaskForm) => void
  readonly onCancel: () => void
  readonly onSave: () => void
}

// `inputStyle` / `optionStyle` / `buttonStyle` 统一定义在文件顶部（跟 token 放一起）


export function TaskEditor(props: TaskEditorProps): ReactNode {
  const { t, form, onChange } = props
  const schedule = form.schedule

  const patch = (part: Partial<TaskForm>): void => onChange({ ...form, ...part })
  const patchSchedule = (part: Record<string, unknown>): void =>
    onChange({ ...form, schedule: { ...schedule, ...part } as TaskForm['schedule'] })

  const rows: ReactNode[] = [
    createElement(
      'div',
      { key: 'grid', style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' } },
      createElement(Field, {
        key: 'id',
        label: t('taskId'),
        children: createElement('input', {
          style: inputStyle,
          value: form.id,
          onChange: (event: { target: { value: string } }) => patch({ id: event.target.value }),
        }),
      }),
      createElement(Field, {
        key: 'name',
        label: t('taskName'),
        children: createElement('input', {
          style: inputStyle,
          value: form.name,
          onChange: (event: { target: { value: string } }) => patch({ name: event.target.value }),
        }),
      }),
      createElement(Field, {
        key: 'session',
        label: t('session'),
        children:
          props.sessions.length > 0
            ? createElement(
                'select',
                {
                  style: inputStyle,
                  value: form.session,
                  onChange: (event: { target: { value: string } }) => patch({ session: event.target.value }),
                },
                createElement('option', { style: optionStyle, value: '' }, t('sessionPlaceholder')),
                ...props.sessions.map((option) =>
                  createElement(
                    'option',
                    { key: option.sessionId, value: option.sessionId, style: optionStyle },
                    `${option.label} · ${option.sublabel}${option.badge === null ? '' : ` · ${option.badge}`}`,
                  ),
                ),
              )
            : createElement('input', {
                style: inputStyle,
                value: form.session,
                placeholder: t('sessionPlaceholder'),
                onChange: (event: { target: { value: string } }) => patch({ session: event.target.value }),
              }),
      }),
      createElement(Field, {
        key: 'timezone',
        label: t('timezone'),
        children: createElement('input', {
          style: inputStyle,
          value: form.timezone,
          onChange: (event: { target: { value: string } }) => patch({ timezone: event.target.value }),
        }),
      }),
    ),
  ]

  rows.push(
    createElement(
      Field,
      { key: 'type', label: t('scheduleType') },
      createElement(
        'select',
        {
          style: inputStyle,
          value: schedule.type,
          onChange: (event: { target: { value: string } }) => {
            onChange(switchScheduleType(form, event.target.value as TaskForm['schedule']['type'], {
              now: Date.now(),
              timezone: form.timezone || undefined,
            }))
          },
        },
        createElement('option', { style: optionStyle, value: 'once' }, t('once')),
        createElement('option', { style: optionStyle, value: 'daily' }, t('daily')),
        createElement('option', { style: optionStyle, value: 'weekly' }, t('weekly')),
        createElement('option', { style: optionStyle, value: 'interval' }, t('interval')),
        createElement('option', { style: optionStyle, value: 'windowed-interval' }, t('windowedInterval')),
      ),
    ),
  )

  if (schedule.type === 'once' || schedule.type === 'daily') {
    rows.push(
      createElement(Field, {
        key: 'at',
        label: schedule.type === 'once' ? t('atDate') : t('at'),
        children: createElement('input', {
          style: inputStyle,
          value: schedule.at,
          onChange: (event: { target: { value: string } }) => patchSchedule({ at: event.target.value }),
        }),
      }),
    )
  }

  if (schedule.type === 'weekly') {
    rows.push(
      createElement(Field, {
        key: 'at',
        label: t('at'),
        children: createElement('input', {
          style: inputStyle,
          value: schedule.at,
          onChange: (event: { target: { value: string } }) => patchSchedule({ at: event.target.value }),
        }),
      }),
      createElement(Field, {
        key: 'days',
        label: t('days'),
        children: createElement(
          'select',
          {
            style: inputStyle,
            value: schedule.daysMode,
            onChange: (event: { target: { value: string } }) => {
              const mode = event.target.value as 'all' | 'workdays' | 'weekends' | 'custom'
              patchSchedule({
                daysMode: mode,
                days: mode === 'custom' && schedule.days.length === 0 ? ['mon'] : schedule.days,
              })
            },
          },
          createElement('option', { style: optionStyle, value: 'all' }, t('daysAll')),
          createElement('option', { style: optionStyle, value: 'workdays' }, t('daysWorkdays')),
          createElement('option', { style: optionStyle, value: 'weekends' }, t('daysWeekends')),
          createElement('option', { style: optionStyle, value: 'custom' }, t('daysCustom')),
        ),
      }),
    )
    if (schedule.daysMode === 'custom') {
      rows.push(
        createElement(
          'div',
          { key: 'day-picker', style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
          ...DAY_KEYS.map((day) =>
            createElement(
              'label',
              { key: day, style: { display: 'flex', gap: '3px', alignItems: 'center', fontSize: '12px' } },
              createElement('input', {
                type: 'checkbox',
                checked: schedule.days.includes(day),
                onChange: (event: { target: { checked: boolean } }) => {
                  const next = event.target.checked
                    ? [...schedule.days, day]
                    : schedule.days.filter((item) => item !== day)
                  patchSchedule({ days: next })
                },
              }),
              day,
            ),
          ),
        ),
      )
    }
  }

  if (schedule.type === 'interval' || schedule.type === 'windowed-interval') {
    rows.push(
      createElement(Field, {
        key: 'every',
        label: t('every'),
        children: createElement('input', {
          style: inputStyle,
          value: schedule.every,
          onChange: (event: { target: { value: string } }) => patchSchedule({ every: event.target.value }),
        }),
      }),
    )
  }

  if (schedule.type === 'interval') {
    rows.push(
      createElement(
        Field,
        { key: 'anchor', label: t('anchor') },
        createElement(
          'select',
          {
            style: inputStyle,
            value: schedule.anchor,
            onChange: (event: { target: { value: string } }) =>
              patchSchedule({ anchor: event.target.value }),
          },
          createElement('option', { style: optionStyle, value: 'enable-time' }, t('anchorEnable')),
          createElement('option', { style: optionStyle, value: 'interval-end' }, t('anchorIntervalEnd')),
        ),
      ),
    )
  }

  if (schedule.type === 'windowed-interval') {
    rows.push(
      createElement(
        'div',
        { key: 'window', style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' } },
        createElement(Field, {
          key: 'start',
          label: t('windowStart'),
          children: createElement('input', {
            style: inputStyle,
            value: schedule.windowStart,
            onChange: (event: { target: { value: string } }) => patchSchedule({ windowStart: event.target.value }),
          }),
        }),
        createElement(Field, {
          key: 'end',
          label: t('windowEnd'),
          children: createElement('input', {
            style: inputStyle,
            value: schedule.windowEnd,
            onChange: (event: { target: { value: string } }) => patchSchedule({ windowEnd: event.target.value }),
          }),
        }),
      ),
      createElement(
        Field,
        { key: 'align', label: t('align') },
        createElement(
          'select',
          {
            style: inputStyle,
            value: schedule.align,
            onChange: (event: { target: { value: string } }) => patchSchedule({ align: event.target.value }),
          },
          createElement('option', { style: optionStyle, value: 'window-start' }, t('alignWindowStart')),
          createElement('option', { style: optionStyle, value: 'enable-time' }, t('alignEnableTime')),
        ),
      ),
    )
  }

  rows.push(
    createElement(
      Field,
      { key: 'payload', label: t('payloadText') },
      createElement('textarea', {
        style: { ...inputStyle, minHeight: '72px', fontFamily: 'inherit' },
        value: form.payloadText,
        onChange: (event: { target: { value: string } }) => patch({ payloadText: event.target.value }),
      }),
      createElement('span', { style: { fontSize: '12px', opacity: 0.6 } }, t('payloadHint')),
    ),
    createElement(
      'div',
      { key: 'advanced', style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' } },
      createElement(
        Field,
        { key: 'onBusy', label: t('onBusy') },
        createElement(
          'select',
          {
            style: inputStyle,
            value: form.onBusy,
            onChange: (event: { target: { value: string } }) => patch({ onBusy: event.target.value as TaskForm['onBusy'] }),
          },
          createElement('option', { style: optionStyle, value: 'queue' }, t('onBusyQueue')),
          createElement('option', { style: optionStyle, value: 'skip' }, t('onBusySkip')),
          createElement('option', { style: optionStyle, value: 'inject' }, t('onBusyInject')),
        ),
      ),
      createElement(
        Field,
        { key: 'missed', label: t('missed') },
        createElement(
          'select',
          {
            style: inputStyle,
            value: form.missed,
            onChange: (event: { target: { value: string } }) => patch({ missed: event.target.value as TaskForm['missed'] }),
          },
          createElement('option', { style: optionStyle, value: 'skip' }, t('missedSkip')),
          createElement('option', { style: optionStyle, value: 'fire-once' }, t('missedFireOnce')),
        ),
      ),
      createElement(Field, {
        key: 'noReplyMax',
        label: t('noReplyMax'),
        children: createElement('input', {
          style: inputStyle,
          type: 'number',
          min: 0,
          max: 20,
          value: form.noReplyMax,
          onChange: (event: { target: { value: string } }) =>
            patch({ noReplyMax: Number(event.target.value) || 0 }),
        }),
      }),
      createElement(Field, {
        key: 'noReplyWindow',
        label: t('noReplyWindow'),
        children: createElement('input', {
          style: inputStyle,
          value: form.noReplyWindow,
          onChange: (event: { target: { value: string } }) => patch({ noReplyWindow: event.target.value }),
        }),
      }),
    ),
  )

  rows.push(
    createElement(
      'div',
      { key: 'editor-actions', style: { display: 'flex', gap: '8px', marginTop: '8px' } },
      createElement('button', { type: 'button', style: buttonStyle, onClick: props.onSave }, t('save')),
      createElement('button', { type: 'button', style: buttonStyle, onClick: props.onCancel }, t('cancel')),
    ),
  )

  return createElement(
    'div',
    {
      style: {
        marginTop: '12px',
        padding: '12px',
        border: `1px solid ${TOKEN.border}`,
        borderRadius: '8px',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
      },
    },
    ...rows,
  )
}
