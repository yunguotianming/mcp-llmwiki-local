import { excludedMember } from './membership.js'
import path from 'node:path'
import { cachedCentroid, centroid, similarity } from './embedding.js'
import type { LayeredSettings } from '../domain/config.js'
import type { Topic, TopicState } from './schema.js'
import { topicPath } from './schema.js'
export { topicPath } from './schema.js'

export const topicDepth = (topic: Topic): number => topic.id.split('-').length - 2
export const pageLink = (from: string, to: string): string => path.posix.relative(path.posix.dirname(from), to)
export const childrenOf = (state: TopicState, topic: Topic): Topic[] => state.topics.filter(child => child.parent_id === topic.id).sort((a, b) => a.id.localeCompare(b.id))
export const logicalSource = (state: TopicState, pointId: string): string => state.logical_sources?.[pointId.split(':')[0]!] ?? pointId.split(':')[0]!
export const logicalSourceCount = (state: TopicState, topic: Topic): number => new Set(topic.point_ids.map(id => logicalSource(state, id))).size
export function refreshTopic(state: TopicState, topic: Topic): void {
  topic.point_ids = [...new Set(topic.point_ids)].sort()
  if (topic.point_ids.length || !topic.archived) topic.sources = [...new Set(topic.point_ids.map(id => id.split(':')[0]!))].sort()
  topic.centroid = cachedCentroid(topic, topic.point_ids, state.vectors, true)
}
export function refreshTree(state: TopicState): void {
  for (const topic of [...state.topics].sort((a, b) => topicDepth(b) - topicDepth(a))) {
    const children = childrenOf(state, topic)
    if (children.length) topic.point_ids = [...(topic.direct_point_ids ?? []), ...children.flatMap(child => child.point_ids)]
    refreshTopic(state, topic)
  }
  state.topics = state.topics.filter(topic => topic.point_ids.length || topic.archived)
}
export function newTopic(state: TopicState, parent: Topic | undefined, reserved: Set<string>): Topic {
  let id: string
  if (parent) {
    state.next_children ??= {}
    let number = state.next_children[parent.id] ?? 1
    do { id = `${parent.id}-${String(number++).padStart(2, '0')}` } while (reserved.has(id))
    state.next_children[parent.id] = number
  } else {
    do { id = 'T-' + String(state.next_topic_number++).padStart(4, '0') } while (reserved.has(id))
  }
  reserved.add(id)
  const topic: Topic = { id, path: topicPath(id), parent_id: parent?.id ?? null, title: '', summary: '', sources: [], point_ids: [], centroid: [], revisions: 0 }
  state.topics.push(topic)
  return topic
}
// 最远种子确定方向，再按相似度差均衡分组；重复向量也保证拆分推进。
export function partitionTopic(state: TopicState, topic: Topic): string[][] {
  const bySource = new Map<string, string[]>()
  for (const id of [...topic.point_ids].sort()) { const source = logicalSource(state, id); const group = bySource.get(source) ?? []; group.push(id); bySource.set(source, group) }
  const units = bySource.size > 1 ? [...bySource.values()] : topic.point_ids.map(id => [id])
  if (units.length < 2) throw new Error('单个要点不能继续拆分：输入超出单页预算或正文超出长度上限。')
  const vectors = units.map(ids => centroid(ids.map(id => state.vectors[id]!.vector))), first = vectors[0]!
  const farthest = vectors.reduce((best, vector, i) => similarity(first, vector) < similarity(first, vectors[best]!) ? i : best, 0)
  const ranked = units.map((ids, i) => ({ ids, score: similarity(first, vectors[i]!) - similarity(vectors[farthest]!, vectors[i]!) }))
    .sort((a, b) => b.score - a.score || a.ids[0]!.localeCompare(b.ids[0]!))
  const middle = Math.ceil(ranked.length / 2)
  return [ranked.slice(0, middle).flatMap(unit => unit.ids), ranked.slice(middle).flatMap(unit => unit.ids)]
}
export function splitTopic(state: TopicState, topic: Topic, settings: LayeredSettings, reserved: Set<string>): Topic[] {
  const groups = partitionTopic(state, topic)
  const horizontal = topicDepth(topic) >= settings.topicMaxDepth
  const qualified = groups.filter(ids => new Set(ids.map(id => logicalSource(state, id))).size >= settings.topicMergeMinSources)
  if (!qualified.length || horizontal && qualified.length !== groups.length) return []
  const parent = horizontal ? state.topics.find(item => item.id === topic.parent_id) : topic
  if (!horizontal) topic.direct_point_ids = groups.filter(ids => !qualified.includes(ids)).flat()
  const leaves = horizontal ? [topic, newTopic(state, parent, reserved)] : qualified.map(() => newTopic(state, parent, reserved))
  leaves.forEach((leaf, index) => { leaf.point_ids = qualified[index]!; leaf.revisions = 0; refreshTopic(state, leaf) })
  refreshTree(state)
  return leaves
}
export function mergeShrunken(state: TopicState, previous: TopicState, minimum: number, aliases: Record<string, string>): Set<string> {
  const rebuilt = new Set<string>(), visited = new Set<string>()
  for (const old of previous.topics) {
    if (visited.has(old.id)) continue
    let topic = state.topics.find(item => item.id === old.id)
    if (!topic && old.parent_id && !childrenOf(previous, old).length) {
      const sibling = state.topics.filter(item => item.parent_id === old.parent_id && !childrenOf(state, item).length)
        .map(item => ({ item, score: old.centroid.length === item.centroid.length ? similarity(old.centroid, item.centroid) : 0 }))
        .sort((a, b) => b.score - a.score || a.item.id.localeCompare(b.item.id))[0]?.item
      if (sibling) {
        aliases[old.id] = sibling.id
        for (const [id, target] of Object.entries(aliases)) if (target === old.id) aliases[id] = sibling.id
        rebuilt.add(sibling.path)
      }
      continue
    }
    if (!topic?.parent_id || topic.archived || childrenOf(state, topic).length || logicalSourceCount(state, topic) >= minimum || logicalSourceCount(state, topic) >= logicalSourceCount(previous, old)) continue
    const sibling = state.topics.filter(item => !item.archived && item.parent_id === topic!.parent_id && item.id !== topic!.id && !childrenOf(state, item).length)
      .map(item => ({ item, score: similarity(topic!.centroid, item.centroid) }))
      .sort((a, b) => b.score - a.score || a.item.id.localeCompare(b.item.id))[0]?.item
    if (!sibling) continue
    const keep = sibling.sources.length > topic.sources.length || sibling.sources.length === topic.sources.length && sibling.id < topic.id ? sibling : topic
    const removed = keep === topic ? sibling : topic
    if (removed.point_ids.some(id => excludedMember(state, keep.id, id)) || keep.point_ids.some(id => excludedMember(state, removed.id, id))) continue
    if (state.excluded_members?.[removed.id]) state.excluded_members[keep.id] = { ...state.excluded_members[keep.id], ...state.excluded_members[removed.id] }
    keep.point_ids.push(...removed.point_ids); keep.revisions = 0; refreshTopic(state, keep)
    state.topics = state.topics.filter(topic => topic.id !== removed.id)
    aliases[removed.id] = keep.id
    for (const [id, target] of Object.entries(aliases)) if (target === removed.id) aliases[id] = keep.id
    rebuilt.add(keep.path); visited.add(keep.id); visited.add(removed.id)
  }
  refreshTree(state)
  // 目标的整个分支已消失时不保留悬空重定向。
  for (const [id, target] of Object.entries(aliases)) if (!state.topics.some(topic => topic.id === target)) delete aliases[id]
  return rebuilt
}
