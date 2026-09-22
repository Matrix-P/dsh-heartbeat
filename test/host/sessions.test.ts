import { describe, expect, it } from 'vitest'

import { classifySession, IM_SESSION_PREFIX } from '../../src/session-kind.js'
import type { SessionRecordLike, TitleObservationLike } from '../../src/host/sessions.js'
import { toCandidatePayload } from '../../src/host/sessions.js'

function record(
  id: string,
  extra: { origin?: string; parentSession?: unknown; createdAt?: number } = {},
): SessionRecordLike {
  return { header: { id, ...extra } }
}

function title(sessionId: string, text: string, updatedAt: number): TitleObservationLike {
  return { ok: true, sessionId, value: { title: { title: text, updatedAt } } }
}

describe('classifySession — 客户端与服务端共用的分类规则（设计 10.5）', () => {
  it('普通会话 → root', () => {
    expect(classifySession({ id: 'wb-demo-session-0001' })).toBe('root')
  })

  it('官方标了 subagent 的 → subagent', () => {
    expect(classifySession({ id: 'child', origin: 'subagent' })).toBe('subagent')
  })

  it('带 parentSession 的 → subagent（origin 缺失也要判出来）', () => {
    expect(classifySession({ id: 'child', parentSession: 'parent' })).toBe('subagent')
  })

  it('im: 前缀 → plugin-channel（IM 会话本质仍是根会话）', () => {
    expect(IM_SESSION_PREFIX).toBe('im:')
    expect(classifySession({ id: 'im:demo:dm:0:sample' })).toBe('plugin-channel')
  })

  it('前缀不在开头就不算 IM', () => {
    expect(classifySession({ id: 'wb-im:xxx' })).toBe('root')
  })
})

describe('toCandidatePayload — host 侧装配（FR-4 第 2 条 / 12.5）', () => {
  it('**子会话在服务端就被筛掉**，不能只靠界面过滤', () => {
    const payload = toCandidatePayload(
      [
        record('root-a'),
        record('child-a', { origin: 'subagent' }),
        record('child-b', { parentSession: 'root-a' }),
      ],
      [],
    )

    expect(payload.map((item) => item.sessionId)).toEqual(['root-a'])
  })

  it('主标题取标题快照，取不到时为 null（绝不回落成 sessionId）', () => {
    const payload = toCandidatePayload(
      [record('s1'), record('s2')],
      [title('s1', '和朋友的对话', 1_000)],
    )

    expect(payload.find((item) => item.sessionId === 's1')?.title).toBe('和朋友的对话')
    expect(payload.find((item) => item.sessionId === 's2')?.title).toBeNull()
  })

  it('空白标题算取不到', () => {
    const payload = toCandidatePayload([record('s1')], [title('s1', '   ', 1_000)])
    expect(payload[0]?.title).toBeNull()
  })

  it('ok:false 的观察被忽略（不影响其它会话）', () => {
    const payload = toCandidatePayload(
      [record('s1'), record('s2')],
      [
        { ok: false, sessionId: 's1', value: { title: { title: '不该出现' } } },
        title('s2', '正常标题', 5),
      ],
    )

    expect(payload.find((item) => item.sessionId === 's1')?.title).toBeNull()
    expect(payload.find((item) => item.sessionId === 's2')?.title).toBe('正常标题')
  })

  it('按最近活跃降序：标题快照的 updatedAt 优先，回落 header.createdAt', () => {
    const payload = toCandidatePayload(
      [record('old', { createdAt: 100 }), record('new', { createdAt: 200 })],
      [title('old', '旧的', 900)],
    )

    // old 因标题更新时间 900 反超 new 的 createdAt 200
    expect(payload.map((item) => item.sessionId)).toEqual(['old', 'new'])
    expect(payload.map((item) => item.updatedAt)).toEqual([900, 200])
  })

  it('两处都没有时间戳时按 0 处理，不产生 NaN', () => {
    const payload = toCandidatePayload([record('s1')], [])
    expect(payload[0]?.updatedAt).toBe(0)
  })

  it('IM 会话会被带出来并标成 plugin-channel（可选，界面打标签）', () => {
    const payload = toCandidatePayload([record('im:qq_x:dm:1:abc')], [])
    expect(payload[0]?.kind).toBe('plugin-channel')
  })
})
