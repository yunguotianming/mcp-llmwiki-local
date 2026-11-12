import { excludedMember } from './membership.js'
import type { LayeredSettings } from '../domain/config.js'
import { cachedCentroid, similarity } from './embedding.js'
import { hash } from './files.js'
import { childrenOf, logicalSource, newTopic, refreshTree } from './hierarchy.js'
import type { TopicState } from './schema.js'

export const clusteringVersion = 'bounded-average-linkage-v2'
export interface ClusterStats {
  maxBlockSize: number; maxNeighbors: number; graphEdges: number; peakHeap: number
  comparisons: number; clusteredPoints: number
}
interface Group { ids: string[]; mean: number[] }
interface Edge { a: number; b: number; score: number }
const order = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
const dot = (a: number[], b: number[]) => { let sum = 0; for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!; return sum }

class Heap<T> {
  items: T[] = []
  constructor(private readonly before: (a: T, b: T) => boolean) {}
  push(value: T): void {
    let i = this.items.length; this.items.push(value)
    while (i > 0) { const parent = (i - 1) >> 1; if (!this.before(value, this.items[parent]!)) break; this.items[i] = this.items[parent]!; i = parent }
    this.items[i] = value
  }
  pop(): T | undefined {
    const first = this.items[0], last = this.items.pop()
    if (!this.items.length) return first
    let i = 0
    while (i * 2 + 1 < this.items.length) {
      let child = i * 2 + 1
      if (child + 1 < this.items.length && this.before(this.items[child + 1]!, this.items[child]!)) child++
      if (!this.before(this.items[child]!, last!)) break
      this.items[i] = this.items[child]!; i = child
    }
    this.items[i] = last!; return first
  }
}

// 块内逐对扫描只保留每点 k 个近邻；跨块用四个确定性投影的相邻窗口补边。
// 不分配距离矩阵。大库跨块召回为近似近邻，空间为 O(n·(维度+k))。
function graph(groups: Group[], settings: LayeredSettings, stats: ClusterStats): Set<number>[] {
  const count = groups.length, k = Math.min(settings.topicNeighborCount, count - 1), block = settings.topicClusterBlockSize
  const near = groups.map(() => new Heap<{ id: number; score: number }>((a, b) => a.score < b.score || a.score === b.score && a.id > b.id))
  const add = (a: number, b: number, score: number) => {
    if (k < 1) return
    const heap = near[a]!, worst = heap.items[0]
    if (heap.items.length === k && (score < worst!.score || score === worst!.score && b > worst!.id)) return
    heap.push({ id: b, score }); if (heap.items.length > k) heap.pop()
  }
  const compare = (a: number, b: number) => { stats.comparisons++; const score = dot(groups[a]!.mean, groups[b]!.mean); add(a, b, score); add(b, a, score) }
  for (let start = 0; start < count; start += block) {
    const end = Math.min(count, start + block); stats.maxBlockSize = Math.max(stats.maxBlockSize, end - start)
    for (let a = start; a < end; a++) for (let b = a + 1; b < end; b++) compare(a, b)
  }
  if (count > block) {
    // 每轮只保留一个投影排序；不保存跨块候选对集合。
    for (let projection = 0; projection < 4; projection++) {
      const ranked = groups.map((group, id) => {
        let value = 0, seed = projection + 1
        for (const coordinate of group.mean) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; value += coordinate * (seed & 1 << 16 ? 1 : -1) }
        return { id, value }
      }).sort((a, b) => a.value - b.value || a.id - b.id)
      for (let i = 0; i < count; i++) for (let j = i + 1; j < Math.min(count, i + k + 1); j++) {
        const a = ranked[i]!.id, b = ranked[j]!.id
        if (Math.floor(a / block) === Math.floor(b / block)) continue
        // 投影可能重复召回同一邻居；已有边不占多个名额。
        if (near[a]!.items.some(item => item.id === b) || near[b]!.items.some(item => item.id === a)) continue
        compare(a, b)
      }
    }
  }
  const edges = groups.map(() => new Set<number>())
  near.forEach((heap, id) => {
    stats.maxNeighbors = Math.max(stats.maxNeighbors, heap.items.length)
    for (const item of heap.items) { edges[id]!.add(item.id); edges[item.id]!.add(id) }
  })
  stats.graphEdges = Math.max(stats.graphEdges, edges.reduce((sum, edge) => sum + edge.size, 0) / 2)
  return edges
}

function agglomerate(initial: Group[], settings: LayeredSettings, stats: ClusterStats): Group[] {
  if (initial.length < 2) return initial
  const groups: (Group | undefined)[] = [...initial], edges = graph(initial, settings, stats)
  let heap = new Heap<Edge>((a, b) => a.score > b.score || a.score === b.score && (a.a < b.a || a.a === b.a && a.b < b.b))
  const enqueue = (a: number, b: number) => {
    stats.comparisons++
    // 未归一化的簇均值点积，严格等于全部跨簇要点对的平均余弦。
    const score = dot(groups[a]!.mean, groups[b]!.mean)
    if (score >= settings.topicSimilarityThreshold) heap.push({ a: Math.min(a, b), b: Math.max(a, b), score })
  }
  const rebuild = () => {
    heap = new Heap<Edge>((a, b) => a.score > b.score || a.score === b.score && (a.a < b.a || a.a === b.a && a.b < b.b))
    for (let a = 0; a < groups.length; a++) if (groups[a]) for (const b of edges[a]!) if (a < b) enqueue(a, b)
  }
  rebuild()
  const heapLimit = Math.max(1, stats.graphEdges * 4)
  for (;;) {
    stats.peakHeap = Math.max(stats.peakHeap, heap.items.length)
    const edge = heap.pop(); if (!edge) break
    const a = groups[edge.a], b = groups[edge.b]
    if (!a || !b) continue
    const id = groups.length, size = a.ids.length + b.ids.length
    const mean = a.mean.map((value, i) => (value * a.ids.length + b.mean[i]! * b.ids.length) / size)
    groups.push({ ids: [...a.ids, ...b.ids].sort(order), mean })
    const neighbors = new Set([...edges[edge.a]!, ...edges[edge.b]!]); neighbors.delete(edge.a); neighbors.delete(edge.b)
    groups[edge.a] = undefined; groups[edge.b] = undefined
    edges[edge.a]!.clear(); edges[edge.b]!.clear(); edges.push(neighbors)
    for (const other of neighbors) { edges[other]!.delete(edge.a); edges[other]!.delete(edge.b); edges[other]!.add(id); enqueue(id, other) }
    // 丢弃失效堆项，合并次数不会把堆累积成平方空间。
    if (heap.items.length > heapLimit) rebuild()
  }
  return groups.filter((group): group is Group => !!group).sort((a, b) => order(a.ids[0]!, b.ids[0]!))
}

export function clusterPoints(ids: string[], vectors: TopicState['vectors'], settings: LayeredSettings): { groups: string[][]; stats: ClusterStats } {
  const sorted = [...new Set(ids)].sort(order)
  const stats: ClusterStats = { maxBlockSize: 0, maxNeighbors: 0, graphEdges: 0, peakHeap: 0, comparisons: 0, clusteredPoints: sorted.length }
  const groups: Group[] = []
  for (let start = 0; start < sorted.length; start += settings.topicClusterBlockSize) {
    const block = sorted.slice(start, start + settings.topicClusterBlockSize).map(id => ({ ids: [id], mean: vectors[id]!.vector }))
    stats.maxBlockSize = Math.max(stats.maxBlockSize, block.length)
    groups.push(...agglomerate(block, settings, stats))
  }
  const result = sorted.length > settings.topicClusterBlockSize ? agglomerate(groups, settings, stats) : groups
  return { groups: result.map(group => group.ids), stats }
}

function candidateGroups(state: TopicState, available: string[]): string[][] {
  const remaining = new Set(available.filter(id => state.vectors[id]))
  const groups = (state.candidates ?? []).map(group => group.filter(id => remaining.delete(id))).filter(group => group.length)
  // 兼容旧版本漏存的未归属要点；单点候选不推断新的语义分组。
  return [...groups, ...[...remaining].sort(order).map(id => [id])]
}

export function retainUnassignedCandidates(state: TopicState): void {
  const assigned = new Set(state.topics.filter(topic => !topic.archived).flatMap(topic =>
    childrenOf(state, topic).length ? topic.direct_point_ids ?? [] : topic.point_ids))
  state.candidates = candidateGroups(state, Object.keys(state.vectors).filter(id => !assigned.has(id)))
    .map(group => group.sort(order)).sort((a, b) => order(a[0]!, b[0]!))
}

export function updateTopicCandidates(state: TopicState, previous: TopicState, settings: LayeredSettings, reserved: Set<string>): ClusterStats {
  const currentSources = new Set([...Object.keys(state.logical_sources ?? {}), ...Object.keys(state.vectors).map(id => id.split(':')[0]!)])
  for (const topic of state.topics) {
    reserved.add(topic.id)
    topic.point_ids = topic.point_ids.filter(id => state.vectors[id] && !excludedMember(state, topic.id, id))
    if (topic.direct_point_ids) topic.direct_point_ids = topic.direct_point_ids.filter(id => state.vectors[id] && !excludedMember(state, topic.id, id))
    topic.sources = topic.sources.filter(id => currentSources.has(id))
    if (!topic.point_ids.length) topic.archived = true
  }
  // 无有效要点的旧主题也保留身份；发布层生成不含失效引文的旧页。
  refreshTree(state)
  const fingerprint = hash(JSON.stringify([clusteringVersion, settings.topicSimilarityThreshold, settings.topicAttachThreshold,
    settings.topicMergeMinSources, settings.topicMaxPoints, settings.topicClusterBlockSize, settings.topicNeighborCount,
    state.embedding.identity ?? { model: state.embedding.model, precision: state.embedding.precision }]))
  const reconfigure = previous.clustering_fingerprint !== fingerprint
  const existing = state.topics.filter(topic => (reconfigure || !topic.archived) && !childrenOf(state, topic).length).sort((a, b) => order(a.id, b.id))
  const assigned = new Set(state.topics.filter(topic => !topic.archived).flatMap(topic => childrenOf(state, topic).length ? topic.direct_point_ids ?? [] : topic.point_ids))
  const available = Object.keys(state.vectors).filter(id => reconfigure || !assigned.has(id)).sort(order)
  const availableSet = new Set(available)
  const old = candidateGroups(previous, available)
  // 只按输入身份判断新增或变化：向量模型、精度、阈值变化已进入聚类指纹并整体重算（reconfigure）。
  // 不比较向量值和向量 ID：纯全文库的词项向量随 IDF 整体变化，若按向量值判活跃，每次增量都会全库重聚。
  const active = new Set(available.filter(id => {
    const before = previous.vectors[id], current = state.vectors[id]!
    return !before || before.input_hash !== current.input_hash || logicalSource(previous, id) !== logicalSource(state, id)
  }))
  for (const [topicId, members] of Object.entries(previous.excluded_members ?? {})) for (const id of Object.keys(members)) {
    if (availableSet.has(id) && !state.excluded_members?.[topicId]?.[id]) active.add(id)
  }
  if (reconfigure) available.forEach(id => active.add(id))
  // 候选簇是持久化的局部单元；新点触及其中任一点，就把整簇纳入本轮。
  // 扫描不保存距离，未触及的簇直接保留，不参加层次重聚。
  // Set 保留旧簇索引顺序，触及后立即移除，避免后续新点重复扫描。
  const untouched = new Set(old.map((_, index) => index)), seeds = [...active]
  for (const id of seeds) {
    for (const index of untouched) {
      const group = old[index]!
      if (!group.some(other => active.has(other) || similarity(state.vectors[id]!.vector, state.vectors[other]!.vector) >= settings.topicSimilarityThreshold)) continue
      untouched.delete(index)
      // 被带入的旧点不继续传播触及，避免相似链把与本轮输入无关的旧簇拉进来。
      for (const other of group) active.add(other)
    }
  }
  const clustered = clusterPoints([...active], state.vectors, settings)
  const candidates = clustered.groups
  const pending = old.filter((_, index) => untouched.has(index))
  const qualified = candidates.filter(ids => {
    if (new Set(ids.map(id => logicalSource(state, id))).size >= settings.topicMergeMinSources) return true
    pending.push(ids); return false
  })
  if (reconfigure) {
    // 重聚结果按最大成员交集一对一接续身份；未匹配的已发布主题仍保留为旧页。
    const memberships = new Map<string, typeof existing>()
    for (const topic of existing) for (const id of topic.point_ids) memberships.set(id, [...(memberships.get(id) ?? []), topic])
    const matches = qualified.flatMap((ids, group) => {
      const overlaps = new Map<typeof existing[number], number>()
      for (const id of ids) for (const topic of memberships.get(id) ?? []) overlaps.set(topic, (overlaps.get(topic) ?? 0) + 1)
      return [...overlaps].map(([topic, overlap]) => ({ group, topic, overlap }))
    }).sort((a, b) => b.overlap - a.overlap || order(a.topic.id, b.topic.id) || a.group - b.group)
    const owners = new Map<number, typeof existing[number]>(), used = new Set<string>()
    for (const match of matches) if (!owners.has(match.group) && !used.has(match.topic.id) && !qualified[match.group]!.some(id => excludedMember(state, match.topic.id, id))) { owners.set(match.group, match.topic); used.add(match.topic.id) }
    for (const topic of state.topics) topic.archived = true
    qualified.forEach((ids, index) => {
      const topic = owners.get(index) ?? newTopic(state, undefined, reserved)
      delete topic.archived; topic.point_ids = ids
    })
  } else {
    // 近邻图只筛选候选簇对；未归一化均值的点积才是成员两两平均相似度。
    const means = new WeakMap<string[], { count: number; value: number[] }>()
    const mean = (ids: string[]) => {
      const cached = means.get(ids)
      if (cached?.count === ids.length) return cached.value
      const value = state.vectors[ids[0]!]!.vector.map(() => 0)
      // 本循环只追加成员；按成员数失效。仍逐成员先除后加，保持旧浮点求和顺序。
      for (const id of ids) {
        const vector = state.vectors[id]!.vector
        for (let i = 0; i < value.length; i++) value[i]! += vector[i]! / ids.length
      }
      means.set(ids, { count: ids.length, value })
      return value
    }
    const seeds = [...existing.map(topic => topic.point_ids), ...qualified].map(ids => ({ ids, mean: mean(ids) }))
    const edges = qualified.length ? graph(seeds, settings, clustered.stats) : []
    qualified.forEach((ids, index) => {
      const group = seeds[existing.length + index]!
      const nearest = [...edges[existing.length + index]!].filter(other => other < existing.length && !ids.some(id => excludedMember(state, existing[other]!.id, id)))
        .map(other => ({ topic: existing[other]!, score: dot(group.mean, mean(existing[other]!.point_ids)) }))
        .sort((a, b) => b.score - a.score || order(a.topic.id, b.topic.id))[0]
      if (nearest && nearest.score >= settings.topicSimilarityThreshold) nearest.topic.point_ids.push(...ids)
      else newTopic(state, undefined, reserved).point_ids = ids
    })
  }
  for (const topic of state.topics) if (topic.point_ids.length) topic.centroid = cachedCentroid(topic, topic.point_ids, state.vectors)
  // 本轮固定质心后再批量归入，避免处理顺序改变阈值和归属。
  const leaves = state.topics.filter(topic => !childrenOf(state, topic).length).sort((a, b) => order(a.id, b.id))
  state.candidates = []
  for (const group of pending) {
    const remaining: string[] = []
    for (const id of group) {
      if (!active.has(id)) { remaining.push(id); continue }
      let best: typeof leaves[number] | undefined, score = -Infinity
      for (const topic of leaves) {
        if (excludedMember(state, topic.id, id) || topic.archived && topic.point_ids.includes(id)) continue
        if (topic.centroid.length !== state.vectors[id]!.vector.length) continue
        const current = similarity(state.vectors[id]!.vector, topic.centroid)
        if (current > score) { best = topic; score = current }
      }
      if (best && score >= settings.topicAttachThreshold) { best.point_ids.push(id); delete best.archived }
      else remaining.push(id)
    }
    if (remaining.length) state.candidates.push(remaining)
  }
  const nowAssigned = new Set(leaves.filter(topic => !topic.archived).flatMap(topic => topic.point_ids))
  state.candidates = state.candidates.map(group => group.filter(id => !nowAssigned.has(id))).filter(group => group.length)
  state.clustering_fingerprint = fingerprint
  refreshTree(state)
  return clustered.stats
}
