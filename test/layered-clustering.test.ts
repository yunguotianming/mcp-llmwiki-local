import { expect, it } from 'vitest'
import { layeredSettings } from '../src/domain/config.js'
import { clusterPoints, updateTopicCandidates } from '../src/layered/clustering.js'
import { childrenOf, newTopic, refreshTree, splitTopic } from '../src/layered/hierarchy.js'
import type { TopicState } from '../src/layered/schema.js'

const state = (): TopicState => ({ format_version: 1, version: null, next_topic_number: 1, embedding: { url: 'mock', model: 'mock' }, topics: [], vectors: {} })
const point = (value: TopicState, id: string, vector: number[]) => { value.vectors[id] = { input_hash: id, vector } }
const run = (value: TopicState, previous = state(), settings = layeredSettings()) => updateTopicCandidates(value, previous, settings, new Set(previous.topics.map(topic => topic.id)))

it('平均链接在 0.65 含等号合并，乱序输入的成员与 ID 一致', () => {
  const vectors = state()
  point(vectors, 'S-1:a', [1, 0]); point(vectors, 'S-2:a', [.65, Math.sqrt(1 - .65 ** 2)])
  const settings = layeredSettings({ topicMergeMinSources: 2 })
  expect(clusterPoints(Object.keys(vectors.vectors), vectors.vectors, settings).groups).toHaveLength(1)
  expect(clusterPoints(Object.keys(vectors.vectors), vectors.vectors, { ...settings, topicSimilarityThreshold: .650001 }).groups).toHaveLength(2)
  const a = state(), b = state()
  for (const i of [1, 2, 3, 4, 5, 6]) point(a, `S-${i}:a`, i <= 3 ? [1, 0] : [0, 1])
  for (const [id, vector] of Object.entries(a.vectors).reverse()) b.vectors[id] = vector
  run(a); run(b)
  expect(a.topics).toEqual(b.topics); expect(a.candidates).toEqual(b.candidates)
})

it('新主题至少三逻辑来源，同一书多个物理片段不重复计票', () => {
  const value = state()
  for (const i of [1, 2, 3]) point(value, `S-${i}:a`, [1, 0])
  value.logical_sources = { 'S-1': '书甲', 'S-2': '书甲', 'S-3': '书乙' }
  run(value); expect(value.topics).toHaveLength(0); expect(value.candidates?.flat()).toHaveLength(3)
  const old = structuredClone(value)
  point(value, 'S-4:a', [1, 0]); value.logical_sources['S-4'] = '书丙'
  run(value, old); expect(value.topics).toHaveLength(1); expect(value.topics[0]!.sources).toHaveLength(4)
  expect(value.candidates).toEqual([])
})

it('不够成页的单点按固定主题质心在 0.60 含等号并入', () => {
  const value = state()
  for (const i of [1, 2, 3]) point(value, `S-${i}:a`, [1, 0, 0])
  run(value); const old = structuredClone(value), id = value.topics[0]!.id
  point(value, 'S-4:a', [.60, Math.sqrt(1 - .60 ** 2), 0])
  point(value, 'S-5:a', [.599999, 0, Math.sqrt(1 - .599999 ** 2)])
  run(value, old)
  expect(value.topics[0]!.id).toBe(id); expect(value.topics[0]!.point_ids).toContain('S-4:a')
  expect(value.candidates).toEqual([['S-5:a']])
})

it('增量只重聚受影响候选，旧主题 ID 保持，候选凑齐后晋升', () => {
  const value = state()
  for (const i of [1, 2, 3]) point(value, `S-${i}:a`, [1, 0, 0])
  for (const i of [4, 5]) point(value, `S-${i}:a`, [0, 1, 0])
  for (const i of [6, 7]) point(value, `S-${i}:a`, [0, 0, 1])
  run(value); const old = structuredClone(value), topic = structuredClone(value.topics[0])
  point(value, 'S-8:a', [0, 1, 0])
  expect(run(value, old).clusteredPoints).toBe(3)
  expect(value.topics[0]).toEqual(topic); expect(value.topics[1]!.sources).toEqual(['S-4', 'S-5', 'S-8'])
  expect(value.candidates).toEqual([['S-6:a', 'S-7:a']])
  expect(run(value, structuredClone(value)).clusteredPoints).toBe(0)
})

it('分块和近邻上限生效、距离存储有界，超过 40 点沿层级拆分', () => {
  const value = state(), settings = layeredSettings({ topicClusterBlockSize: 37, topicNeighborCount: 3 })
  for (let i = 0; i < 600; i++) point(value, `S-${String(i).padStart(4, '0')}:a`, i % 2 ? [1, 0] : [0, 1])
  const result = clusterPoints(Object.keys(value.vectors), value.vectors, settings)
  expect(clusterPoints(Object.keys(value.vectors).reverse(), value.vectors, settings).groups).toEqual(result.groups)
  expect(result.stats.maxBlockSize).toBeLessThanOrEqual(37); expect(result.stats.maxNeighbors).toBe(3)
  expect(result.stats.graphEdges).toBeLessThanOrEqual(600 * 3)
  expect(result.stats.peakHeap).toBeLessThanOrEqual(result.stats.graphEdges * 5)
  expect(result.stats.comparisons).toBeLessThan(600 * 599 / 2)
  expect(result.groups.flat().sort()).toEqual(Object.keys(value.vectors).sort())
  const reserved = new Set<string>(), topic = newTopic(value, undefined, reserved)
  topic.point_ids = Object.keys(value.vectors).slice(0, 41); refreshTree(value)
  const id = topic.id
  while (value.topics.some(topic => !childrenOf(value, topic).length && topic.point_ids.length > settings.topicMaxPoints)) {
    splitTopic(value, value.topics.find(topic => !childrenOf(value, topic).length && topic.point_ids.length > settings.topicMaxPoints)!, settings, reserved)
  }
  expect(value.topics.some(topic => topic.id === id)).toBe(true)
  expect(childrenOf(value, topic)).toHaveLength(2)
  expect(value.topics.filter(topic => !childrenOf(value, topic).length).every(topic => topic.point_ids.length <= 40)).toBe(true)
})
