import { describe, expect, it } from 'vitest'

import type { TemplateError, TemplateNode } from '../../src/templating/parse.js'
import { parseTemplate, PLACEHOLDER_SPECS } from '../../src/templating/parse.js'

function nodes(text: string): readonly TemplateNode[] {
  const result = parseTemplate(text)
  if (!result.ok) {
    throw new Error(`期望解析成功，却报错：${result.errors.map((e) => e.message).join(' / ')}`)
  }
  return result.nodes
}

function failures(text: string): readonly TemplateError[] {
  const result = parseTemplate(text)
  if (result.ok) throw new Error(`期望解析失败，却成功了：${text}`)
  return result.errors
}

describe('parseTemplate — 词汇表', () => {
  it('恰好 13 个变量（需求 FR-7 / D-11）', () => {
    expect(Object.keys(PLACEHOLDER_SPECS)).toHaveLength(13)
  })

  it('包含需求列出的全部变量名', () => {
    expect(Object.keys(PLACEHOLDER_SPECS).sort()).toEqual(
      [
        'date',
        'datetime',
        'fireCount',
        'lastFiredAt',
        'lastUserMsgAt',
        'nextFireAt',
        'noReplyStreak',
        'random',
        'sinceLastUserMsg',
        'taskId',
        'taskName',
        'time',
        'weekday',
      ].sort(),
    )
  })
})

describe('parseTemplate — 纯文本与变量', () => {
  it('纯文本', () => {
    expect(nodes('你好呀')).toEqual([{ kind: 'text', value: '你好呀' }])
  })

  it('空串', () => {
    expect(nodes('')).toEqual([])
  })

  it('单个变量', () => {
    expect(nodes('{time}')).toEqual([{ kind: 'variable', name: 'time', param: null, offset: 0 }])
  })

  it('带格式参数的变量', () => {
    expect(nodes('{time:HH:mm:ss}')).toEqual([
      { kind: 'variable', name: 'time', param: 'HH:mm:ss', offset: 0 },
    ])
  })

  it('文本与变量混合，顺序保持', () => {
    expect(nodes('现在是{time}，{weekday}')).toEqual([
      { kind: 'text', value: '现在是' },
      { kind: 'variable', name: 'time', param: null, offset: 3 },
      { kind: 'text', value: '，' },
      { kind: 'variable', name: 'weekday', param: null, offset: 10 },
    ])
  })

  it('相邻文本节点会合并', () => {
    expect(nodes('a{{b')).toEqual([{ kind: 'text', value: 'a{b' }])
  })

  it('记录字符偏移，便于界面定位', () => {
    expect(nodes('你好{taskId}')).toEqual([
      { kind: 'text', value: '你好' },
      { kind: 'variable', name: 'taskId', param: null, offset: 2 },
    ])
  })

  it('random 的范围参数', () => {
    expect(nodes('{random:1-100}')).toEqual([
      { kind: 'variable', name: 'random', param: '1-100', offset: 0 },
    ])
  })
})

describe('parseTemplate — 花括号转义（FR-7 第 5 条）', () => {
  it('{{ → 字面 {', () => {
    expect(nodes('{{')).toEqual([{ kind: 'text', value: '{' }])
  })

  it('}} → 字面 }', () => {
    expect(nodes('}}')).toEqual([{ kind: 'text', value: '}' }])
  })

  it('{{time}} 整体是字面量，不会被当成变量', () => {
    expect(nodes('{{time}}')).toEqual([{ kind: 'text', value: '{time}' }])
  })

  it('字面量花括号与真实变量混用', () => {
    expect(nodes('{{time}} 实际是 {time}')).toEqual([
      { kind: 'text', value: '{time} 实际是 ' },
      { kind: 'variable', name: 'time', param: null, offset: 13 },
    ])
  })
})

describe('parseTemplate — 错误全部收集（需求 8.6）', () => {
  it('一次报出多个未知变量', () => {
    const list = failures('{now} 和 {then}')
    expect(list).toHaveLength(2)
    expect(list[0]?.offset).toBe(0)
    expect(list[1]?.message).toContain('then')
  })

  it('未知变量报错并带上变量名', () => {
    expect(failures('{now}')[0]?.message).toContain('now')
  })

  it('落单的 { ', () => {
    const list = failures('你好{')
    expect(list[0]?.offset).toBe(2)
    expect(list[0]?.message).toContain('未闭合')
  })

  it('落单的 }', () => {
    expect(failures('你好}')[0]?.message).toContain('落单')
  })

  it('空的占位符 {}', () => {
    expect(failures('{}')[0]?.message).toContain('空')
  })

  it('参数为空 {time:}', () => {
    expect(failures('{time:}')[0]?.message).toContain('参数')
  })

  it('变量名大小写敏感：{TIME} 不合法', () => {
    expect(failures('{TIME}')[0]?.message).toContain('TIME')
  })

  it('变量名里带空格不合法', () => {
    expect(failures('{ time }')).toHaveLength(1)
  })
})

describe('parseTemplate — 参数语法校验', () => {
  it('不接受参数的变量带了参数 → 报错', () => {
    expect(failures('{weekday:HH:mm}')[0]?.message).toContain('weekday')
    expect(failures('{taskId:x}')).toHaveLength(1)
  })

  it('时间类变量校验格式串：拒绝小写 hh', () => {
    expect(failures('{time:hh}')[0]?.message).toMatch(/hh/)
  })

  it('时间类变量接受合法格式串', () => {
    expect(nodes('{date:YYYY年MM月DD日}')).toHaveLength(1)
  })

  it('random 范围必须是「小-大」', () => {
    expect(failures('{random:1}')[0]?.message).toContain('范围')
    expect(failures('{random:abc}')[0]?.message).toContain('范围')
    expect(failures('{random:100-1}')[0]?.message).toContain('范围')
    expect(failures('{random:-1-5}')[0]?.message).toContain('范围')
  })

  it('random 接受合法范围', () => {
    expect(nodes('{random:0-1}')).toHaveLength(1)
    expect(nodes('{random:5-5}')).toHaveLength(1)
  })
})
