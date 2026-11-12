import { expect, it } from 'vitest'
import { cachedCentroid, centroid, normalized } from '../src/layered/embedding.js'
import { newTopic, refreshTree } from '../src/layered/hierarchy.js'
import type { TopicState } from '../src/layered/schema.js'

it('缓存逐字节保留4096维累加顺序、重复成员、抵消回退和空输入', () => {
  let seed = 981
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32 }
  const vectors = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [String(i), { input_hash: String(i), vector: normalized(Array.from({ length: 4096 }, () => random() - .5)) }]))
  const owner = {}
  for (const ids of [Object.keys(vectors), Object.keys(vectors).reverse(), ['1', '1', '2'], []]) {
    const value = cachedCentroid(owner, ids, vectors)
    expect(JSON.stringify(value)).toBe(JSON.stringify(centroid(ids.map(id => vectors[id]!.vector))))
    expect(cachedCentroid(owner, [...ids], vectors)).toBe(value)
  }
  const opposite = { a: { input_hash: 'a', vector: [1, 0] }, b: { input_hash: 'b', vector: [-1, 0] } }
  expect(cachedCentroid(owner, ['a', 'b'], opposite)).toBe(opposite.a.vector)
  expect(cachedCentroid(owner, ['b', 'a'], opposite)).toBe(opposite.b.vector)
})

it('同长成员替换、调序、追加和删除均使缓存失效', () => {
  const owner = {}, vectors = { a: { input_hash: 'a', vector: [1e16, 1] }, b: { input_hash: 'b', vector: [-1e16, 0] }, c: { input_hash: 'c', vector: [1, 0] } }
  const ids = ['a', 'b', 'c'], first = cachedCentroid(owner, ids, vectors)
  ids.splice(0, 3, 'a', 'c', 'b')
  const reordered = cachedCentroid(owner, ids, vectors)
  expect(reordered).not.toEqual(first); expect(reordered).toEqual(centroid(ids.map(id => vectors[id as keyof typeof vectors].vector)))
  for (const members of [['a', 'b', 'a'], ['c'], ['c', 'b'], []]) expect(cachedCentroid(owner, members, vectors)).toEqual(centroid(members.map(id => vectors[id as keyof typeof vectors].vector)))
})

// 产品代码不原地改写向量数组（解码、嵌入、归一化均返回新数组），缓存按数组身份失效，不覆盖原地改值。
it('向量数组、持久身份和输入身份变化分别使缓存失效', () => {
  const owner = {}, vectors = { a: { vector_id: '对象甲', input_hash: '输入甲', vector: [1, 0] }, b: { vector_id: '对象乙', input_hash: '输入乙', vector: [0, 1] } }
  let before = cachedCentroid(owner, ['a', 'b'], vectors)
  for (const change of [() => { vectors.b.vector = [1, 0] }, () => { vectors.b.vector_id = '新对象' }, () => { vectors.b.input_hash = '新输入' }, () => { vectors.b.vector = [0, 1] }]) {
    change(); const after = cachedCentroid(owner, ['a', 'b'], vectors)
    expect(after).not.toBe(before); expect(after).toEqual(centroid([vectors.a.vector, vectors.b.vector])); before = after
  }
})

it('严格与容忍缺失两种口径交替调用各自命中', () => {
  const owner = {}, vectors = { a: { input_hash: 'a', vector: [1, 0] }, b: { input_hash: 'b', vector: [0, 1] } }
  const strict = cachedCentroid(owner, ['a', 'b'], vectors), tolerant = cachedCentroid(owner, ['a', 'b'], vectors, true)
  expect(cachedCentroid(owner, ['a', 'b'], vectors)).toBe(strict)
  expect(cachedCentroid(owner, ['a', 'b'], vectors, true)).toBe(tolerant)
  expect(tolerant).toEqual(strict)
})

it('恢复缺失向量和严格维数校验保持原分支行为', () => {
  const owner = {}, vectors: TopicState['vectors'] = { a: { input_hash: 'a', vector: [] } }
  expect(cachedCentroid(owner, ['a', 'b'], vectors, true)).toEqual([])
  expect(() => cachedCentroid(owner, ['a', 'b'], vectors)).toThrow()
  vectors.b = { input_hash: 'b', vector: [1, 0] }
  expect(cachedCentroid(owner, ['a', 'b'], vectors, true)).toEqual([1, 0])
  expect(() => cachedCentroid(owner, ['a', 'b'], vectors)).toThrow('维度不一致')
  vectors.a.vector = [0, 1]
  expect(cachedCentroid(owner, ['a', 'b'], vectors, true)).toEqual(centroid([vectors.a.vector, vectors.b.vector]))
})

it('refreshTree反复刷新命中，父子成员变化和向量替换后重新计算', () => {
  const state: TopicState = { format_version: 1, version: null, next_topic_number: 1, embedding: { url: 'mock', model: 'mock' }, topics: [], vectors: {
    'S-1:a': { input_hash: 'a', vector: [1, 0] }, 'S-2:b': { input_hash: 'b', vector: [0, 1] } } }
  const root = newTopic(state, undefined, new Set()), child = newTopic(state, root, new Set([root.id]))
  child.point_ids = ['S-1:a']; refreshTree(state)
  const saved = state.topics.map(topic => topic.centroid)
  refreshTree(state); state.topics.forEach((topic, index) => expect(topic.centroid).toBe(saved[index]))
  child.point_ids.push('S-2:b'); refreshTree(state)
  expect(root.centroid).toEqual(centroid([state.vectors['S-1:a']!.vector, state.vectors['S-2:b']!.vector]))
  state.vectors['S-2:b']!.vector = [-1, 0]; refreshTree(state)
  expect(root.centroid).toEqual([1, 0]); expect(child.centroid).toEqual([1, 0])
})
