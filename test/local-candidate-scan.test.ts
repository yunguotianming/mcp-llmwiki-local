import { expect, it } from 'vitest'
import { layeredSettings, type LayeredSettings } from '../src/domain/config.js'
import { clusterPoints, updateTopicCandidates } from '../src/layered/clustering.js'
import { normalized, similarity } from '../src/layered/embedding.js'
import { logicalSource } from '../src/layered/hierarchy.js'
import type { TopicState } from '../src/layered/schema.js'

const empty = (): TopicState => ({ format_version: 1, version: null, next_topic_number: 1, embedding: { url: 'mock', model: 'mock' }, topics: [], vectors: {} })
// 保留身份批的全表扫描作为对照，验证 untouched 优化不改变仅由新点触发的语义。
function expected(state: TopicState, previous: TopicState, settings: LayeredSettings) {
  const available = Object.keys(state.vectors).sort(), allowed = new Set(available.filter(id => previous.vectors[id]))
  const old = (previous.candidates ?? []).map(group => group.filter(id => allowed.delete(id))).filter(group => group.length)
  old.push(...[...allowed].sort().map(id => [id]))
  const active = new Set(available.filter(id => !previous.vectors[id] || previous.vectors[id]?.input_hash !== state.vectors[id]!.input_hash || logicalSource(previous, id) !== logicalSource(state, id)))
  const touched = new Set<number>(), seeds = [...active]
  for (const id of seeds) {
    old.forEach((group, index) => {
      if (touched.has(index)) return
      if (!group.some(other => active.has(other) || similarity(state.vectors[id]!.vector, state.vectors[other]!.vector) >= settings.topicSimilarityThreshold)) return
      touched.add(index)
      for (const other of group) active.add(other)
    })
  }
  const clustered = clusterPoints([...active], state.vectors, settings)
  return { candidates: [...old.filter((_, index) => !touched.has(index)), ...clustered.groups], count: active.size }
}
function check(previous: TopicState, state: TopicState, settings: LayeredSettings) {
  const config = empty(); updateTopicCandidates(config, empty(), settings, new Set())
  previous.clustering_fingerprint = config.clustering_fingerprint!
  const old = expected(state, previous, settings), stats = updateTopicCandidates(state, previous, settings, new Set())
  expect(stats.clusteredPoints).toBe(old.count)
  expect(JSON.stringify(state.candidates)).toBe(JSON.stringify(old.candidates))
  expect(state.topics).toEqual([])
}

it('候选仅由变化输入激活，阈值含等号及未触及簇与身份批语义相同', () => {
  const settings = { ...layeredSettings(), topicSimilarityThreshold: .65, topicMergeMinSources: 1000 }
  const previous = empty()
  for (let i = 0; i < 12; i++) previous.vectors[`S-${i}:p`] = { input_hash: String(i), vector: [Math.cos(i * .7), Math.sin(i * .7)] }
  previous.candidates = [['S-9:p', 'S-10:p'], ['S-3:p', 'S-4:p'], ['S-7:p', 'S-8:p'], ['S-1:p', 'S-2:p'], ['S-5:p', 'S-6:p'], ['S-11:p']]
  check(structuredClone(previous), structuredClone(previous), settings)
  const exact = empty(); exact.vectors.a = { input_hash: 'a', vector: [.65, Math.sqrt(1 - .65 ** 2)] }; exact.candidates = [['a']]
  for (const threshold of [.65 - 1e-12, .65, .65 + 1e-12]) {
    const state = structuredClone(exact); state.vectors.b = { input_hash: 'b', vector: [1, 0] }
    check(structuredClone(exact), state, { ...settings, topicSimilarityThreshold: threshold })
  }
})

it('固定随机种子覆盖新增、删除、输入变化、逻辑来源变化和无活动点', () => {
  let seed = 90817
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32 }
  for (let round = 0; round < 120; round++) {
    const previous = empty(); previous.candidates = []; previous.logical_sources = {}
    const count = 8 + round % 40
    for (let i = 0; i < count; i++) {
      const id = `S-${String(i).padStart(3, '0')}:p`
      previous.vectors[id] = { input_hash: id, vector: normalized(Array.from({ length: 16 }, () => random() - .5)) }
      if (i % 3 === 0) previous.candidates.push([])
      previous.candidates.at(-1)!.push(id)
    }
    const state = structuredClone(previous), ids = Object.keys(state.vectors)
    if (round % 5 === 0) state.vectors.new = { input_hash: '新输入', vector: normalized(Array.from({ length: 16 }, () => random() - .5)) }
    if (round % 5 === 1) state.vectors[ids[0]!]!.input_hash += '变化'
    if (round % 5 === 2) state.logical_sources![ids[0]!.split(':')[0]!] = '新逻辑来源'
    if (round % 5 === 3) delete state.vectors[ids[0]!]
    check(previous, state, { ...layeredSettings(), topicMergeMinSources: 1000, topicSimilarityThreshold: [.2, .65, 1][round % 3]! })
  }
})

it('重配置使全部候选活动时仍逐字节保留旧聚类集合', () => {
  const settings = { ...layeredSettings(), topicMergeMinSources: 1000 }, previous = empty(), state = empty()
  for (let i = 0; i < 60; i++) state.vectors[`S-${i}:p`] = { input_hash: String(i), vector: i % 2 ? [1, 0] : [0, 1] }
  previous.candidates = Object.keys(state.vectors).map(id => [id]); previous.vectors = structuredClone(state.vectors)
  const grouped = clusterPoints(Object.keys(state.vectors), state.vectors, settings)
  const stats = updateTopicCandidates(state, previous, settings, new Set())
  expect(stats.clusteredPoints).toBe(60); expect(state.candidates).toEqual(grouped.groups)
})
