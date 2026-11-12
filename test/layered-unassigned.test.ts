import { expect, it } from 'vitest'
import { layeredSettings } from '../src/domain/config.js'
import { retainUnassignedCandidates, updateTopicCandidates } from '../src/layered/clustering.js'
import { excludedMember } from '../src/layered/membership.js'
import { refreshTree } from '../src/layered/hierarchy.js'
import type { TopicState } from '../src/layered/schema.js'

const empty = (): TopicState => ({ format_version: 1, version: null, next_topic_number: 1,
  embedding: { url: 'mock', model: 'mock' }, topics: [], vectors: {} })
const add = (state: TopicState, id: string, vector: number[]) => { state.vectors[id] = { input_hash: id, vector } }
const run = (state: TopicState, previous = empty(), settings = layeredSettings()) =>
  updateTopicCandidates(state, previous, settings, new Set(previous.topics.map(topic => topic.id)))
const initial = () => {
  const state = empty()
  for (const id of ['S-1:a', 'S-2:a', 'S-3:a', 'S-4:a']) add(state, id, [1, 0, 0])
  run(state)
  state.topics[0]!.point_ids = state.topics[0]!.point_ids.filter(id => id !== 'S-4:a')
  state.excluded_members = { [state.topics[0]!.id]: { 'S-4:a': { content_hash: '原内容', reason: '不同问题' } } }
  refreshTree(state)
  return state
}

it('旧版漏存候选按单点补齐，无关新资料不激活、不改变旧主题', () => {
  const state = initial()
  add(state, 'S-5:a', [.6, .8, 0])
  const previous = structuredClone(state), topic = structuredClone(state.topics[0])
  add(state, 'S-6:a', [0, 0, 1])
  expect(run(state, previous).clusteredPoints).toBe(1)
  expect(state.topics[0]).toEqual(topic)
  expect(state.candidates).toEqual([['S-4:a'], ['S-5:a'], ['S-6:a']])
  expect(run(state, structuredClone(state)).clusteredPoints).toBe(0)
})

it('新点触及整组纳入，未触及组即使达到来源门槛仍保持等待', () => {
  const state = empty()
  add(state, 'S-1:a', [1, 0, 0]); add(state, 'S-2:a', [.8, .6, 0])
  // 这组与被触及的旧点相似，但与本轮新点不相似，不能沿旧点继续扩散。
  for (const id of ['S-3:a', 'S-4:a', 'S-5:a']) add(state, id, [.6, .8, 0])
  run(state)
  state.topics = []; state.candidates = [['S-1:a', 'S-2:a'], ['S-3:a', 'S-4:a', 'S-5:a']]
  const previous = structuredClone(state)
  add(state, 'S-6:a', [.8, -.6, 0])
  expect(run(state, previous).clusteredPoints).toBe(3)
  expect(state.candidates).toContainEqual(['S-3:a', 'S-4:a', 'S-5:a'])
  expect(state.topics.flatMap(topic => topic.point_ids)).not.toContain('S-3:a')
})

// 激活按输入身份判断（与 v0.1.1 相同）。向量值、向量 ID 只在嵌入模型、精度变化时改变，
// 那时聚类指纹改变、整体重聚；纯全文库的词项向量随 IDF 整体漂移，也不能逐条激活。
it('候选自身内容变化会激活；仅向量值或向量 ID 变化不激活；重新配置仍全量重聚', () => {
  const state = initial(); retainUnassignedCandidates(state)
  let previous = structuredClone(state)
  state.vectors['S-4:a']!.input_hash = '变化内容'
  expect(run(state, previous).clusteredPoints).toBe(1)
  previous = structuredClone(state)
  state.vectors['S-4:a']!.vector = [0, 1, 0]
  state.vectors['S-4:a']!.vector_id = '变化向量身份'
  expect(run(state, previous).clusteredPoints).toBe(0)
  expect(run(state, structuredClone(state), layeredSettings({ topicSimilarityThreshold: .9 })).clusteredPoints).toBe(4)
})

it('排除记录失效后恢复归属，有效排除仍约束原主题及子主题', () => {
  const state = initial(); retainUnassignedCandidates(state)
  const id = state.topics[0]!.id, previous = structuredClone(state)
  add(state, 'S-5:a', [1, 0, 0])
  expect(run(state, previous).clusteredPoints).toBe(2)
  expect(state.topics.find(topic => topic.id === id)!.point_ids).not.toContain('S-4:a')
  expect(excludedMember(state, id + '-01', 'S-4:a')).toBe(true)
  const descendant = structuredClone(state)
  descendant.excluded_members![id + '-01'] = { 'S-4:a': { content_hash: '原内容', reason: '已删除子主题' } }
  const excludedByBoth = structuredClone(descendant)
  delete descendant.excluded_members![id + '-01']
  expect(run(descendant, excludedByBoth).clusteredPoints).toBe(1)
  expect(descendant.topics.find(topic => topic.id === id)!.point_ids).not.toContain('S-4:a')
  const blocked = structuredClone(state)
  delete state.excluded_members![id]!['S-4:a']
  expect(run(state, blocked).clusteredPoints).toBe(1)
  expect(state.topics.find(topic => topic.id === id)!.point_ids).toContain('S-4:a')
})

it('保存覆盖所有未归属点，保留原候选组并去除已归属和已删除点，冷建字节稳定', () => {
  const state = initial()
  add(state, 'S-5:a', [0, 1, 0]); add(state, 'S-6:a', [0, 1, 0]); add(state, 'S-7:a', [0, 0, 1])
  state.candidates = [['S-5:a', 'S-6:a', '已删除'], ['S-1:a', 'S-5:a']]
  retainUnassignedCandidates(state)
  expect(state.candidates).toEqual([['S-4:a'], ['S-5:a', 'S-6:a'], ['S-7:a']])
  const cold = () => { const value = initial(); retainUnassignedCandidates(value); return JSON.stringify(value) }
  expect(cold()).toBe(cold())
})
