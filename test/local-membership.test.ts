import { expect, it } from 'vitest'
import { excludedMember } from '../src/layered/membership.js'
import type { TopicState } from '../src/layered/schema.js'

const before = (table: TopicState['excluded_members'], topic: string, point: string) => Object.entries(table ?? {})
  .some(([id, members]) => (topic === id || topic.startsWith(id + '-')) && !!members[point])
const record = { content_hash: '固定身份', reason: '排除' }

it('主题自身、所有连字符祖先、空前缀及非祖先与原全表扫描一致', () => {
  const ids = ['', '-', '--', '-T', 'T', 'T-', 'T--01', 'T-0001', 'T-0001-01', 'T-00010', 'T-0001-01-02', 'constructor', '__proto__']
  for (let mask = 0; mask < 256; mask++) {
    const table = Object.fromEntries(ids.map((id, index) => [id, index % 8 && mask & 1 << (index % 8) ? { 甲: record } : { 乙: record }]))
    const state = { excluded_members: table } as unknown as TopicState
    for (const topic of ids) for (const point of ['甲', '乙', '缺失']) expect(excludedMember(state, topic, point)).toBe(before(table, topic, point))
  }
})

it('表的继承键和不可枚举键不参与，成员继承属性及即时增删保持旧语义', () => {
  const table = Object.create({ 'T-0001': { 甲: record } })
  Object.defineProperty(table, 'T-0001-01', { value: { 甲: record }, enumerable: false })
  table['T-0001-01-02'] = Object.create({ 乙: record })
  const state = { excluded_members: table } as TopicState
  for (const point of ['甲', '乙', 'toString']) expect(excludedMember(state, 'T-0001-01-02', point)).toBe(before(table, 'T-0001-01-02', point))
  table.T = { 甲: record }; expect(excludedMember(state, 'T-0001-01-02', '甲')).toBe(true)
  delete table.T; expect(excludedMember(state, 'T-0001-01-02', '甲')).toBe(false)
  expect(excludedMember({} as TopicState, 'T-0001', '甲')).toBe(false)
})
