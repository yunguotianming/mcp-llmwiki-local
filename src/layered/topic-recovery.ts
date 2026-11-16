import { topicPath } from './schema.js'
import type { Extraction, PendingBuild, SnapshotManifest, Topic, TopicGap, TopicState } from './schema.js'

const transient = /Connection error|timed? out|timeout|terminated|暂时不可用|连接中断|上游.*中断|核对协议缺口|JSON|核对未完成/i
const parentFailure = (gap: TopicGap) => gap.message === '子主题均有生成缺口。'

/** 旧库缺口引用历史成员时，来源层也须保留该成员；不改写已接受的新提取或突破原配额。 */
export function restoreLegacyTopicMembers(current: Extraction, previous: Extraction, wanted: ReadonlySet<string>, sourceVersion: string): Extraction {
  if (current.acceptedRef || current.reextractGeneration || current.source_id !== previous.source_id || current.source_hash !== previous.source_hash) return current
  const existing = new Set(current.segments.flatMap(segment => segment.points.map(point => point.point_id)))
  const restored = previous.segments.flatMap(segment => segment.points.map(point => ({ point, locator: segment.locator }))).filter(({ point, locator }) => wanted.has(point.point_id) && !existing.has(point.point_id)
    && point.verification?.status === 'verified' && point.source_version === sourceVersion
    && point.evidence.length && point.evidence.every(evidence => evidence.source_id === current.source_id && evidence.source_version === sourceVersion)
    && current.segments.some(segment => segment.text_hash === point.text_hash && segment.locator === locator))
  if (!restored.length || existing.size + restored.length > (current.point_limit ?? current.processing.tier)) return current
  const result = structuredClone(current)
  for (const { point, locator } of restored) result.segments.find(segment => segment.text_hash === point.text_hash && segment.locator === locator)!.points.push(structuredClone(point))
  return result
}

/** 旧库只读适配：身份以缺口记录为准，不重新聚类签发编号。 */
export function recoverTopicIdentities(manifest: SnapshotManifest, pending?: PendingBuild['topics']): Topic[] {
  const known = new Map<string, Topic>()
  for (const topic of [...(pending ? [] : manifest.topics?.topics ?? []), ...manifest.topic_recovery?.topics ?? [],
    ...pending?.state.topics ?? [], ...pending?.retry_topics ?? []]) known.set(topic.id, structuredClone(topic))
  for (const gap of pending?.gaps ?? manifest.topic_gaps ?? []) if (!known.has(gap.topic_id)) known.set(gap.topic_id, {
    id: gap.topic_id, path: topicPath(gap.topic_id), parent_id: gap.topic_id.split('-').length > 2 ? gap.topic_id.slice(0, gap.topic_id.lastIndexOf('-')) : null,
    title: '', summary: '', point_ids: [...gap.point_ids], sources: [...new Set(gap.point_ids.map(id => id.split(':')[0]!))],
    centroid: [], revisions: 0, page_status: 'failed',
  })
  return [...known.values()].sort((a, b) => a.id.localeCompare(b.id))
}

export function topicGapDiagnostics(manifest: SnapshotManifest, pending?: PendingBuild['topics']): TopicGap[] {
  const gaps = pending?.gaps ?? manifest.topic_gaps ?? [], topics = recoverTopicIdentities(manifest, pending)
  const pages = pending?.pages ?? manifest.pages ?? {}
  const classify = (gap: TopicGap, seen = new Set<string>()): NonNullable<TopicGap['category']> => {
    if (gap.kind === 'below-threshold' || /来源数不足新主题门槛/.test(gap.message)) return '正常门槛'
    if (parentFailure(gap) && !seen.has(gap.topic_id)) {
      seen.add(gap.topic_id)
      const children = topics.filter(topic => topic.parent_id === gap.topic_id)
      const kinds = children.flatMap(child => gaps.filter(item => item.topic_id === child.id).map(item => classify(item, new Set(seen))))
      if (kinds.length && kinds.every(kind => kind === '正常门槛')) return '正常门槛'
      if (kinds.includes('补跑可补')) return '补跑可补'
    }
    return transient.test(gap.message) || /预算耗尽|未收敛/.test(gap.message) ? '补跑可补' : '需改代码'
  }
  return gaps.map(gap => {
    const category = classify(gap), hasPage = Boolean(pages[topicPath(gap.topic_id)])
    return { ...gap, category, effect: category === '正常门槛' ? '来源层保留' : hasPage
      ? gap.message.startsWith('删除未支撑句') ? '质量审计通知' : '导航降级' : '整页阻塞',
    stage: pending?.repairs?.[gap.topic_id]?.stage ?? manifest.topic_recovery?.repairs[gap.topic_id]?.stage
      ?? (/元数据|范围/.test(gap.message) ? 'metadata' : /核对|删除未支撑句/.test(gap.message) ? 'review'
        : /父主题|子主题/.test(gap.message) ? 'parent' : 'generate') }
  })
}

export function selectTopicGaps(manifest: SnapshotManifest, pending?: PendingBuild['topics'], filter?: { topicIds?: string[]; reasons?: string[] }): TopicGap[] {
  return topicGapDiagnostics(manifest, pending).filter(gap => gap.category !== '正常门槛'
    && (filter?.topicIds === undefined || filter.topicIds.includes(gap.topic_id))
    && (!filter?.reasons?.length || filter.reasons.some(reason => gap.message.includes(reason) || gap.reasons?.some(item => item.reason === reason)))
    && (filter !== undefined || gap.effect !== '质量审计通知'))
}

/** 新请求只并入实际选中的目标，保留同次恢复已完成的尝试与阶段额度。 */
export function requestTopicRecovery(pending: PendingBuild, filter: NonNullable<import('./schema.js').BuildLayeredOptions['retryTopics']>): string[] {
  const selected = [...new Set(selectTopicGaps(pending.manifest, pending.topics, filter).map(gap => gap.topic_id))]
  if (selected.length) {
    const scope = pending.topic_scope ??= { targets: [], completed: [], review_inputs: {} }
    scope.targets = [...new Set([...scope.targets, ...selected])].sort()
  }
  return selected
}

export function persistTopicRecovery(pending: PendingBuild): void {
  const build = pending.topics
  if (!build) return
  const gaps = pending.manifest.topic_gaps ?? build.gaps ?? []
  const ids = new Set(gaps.map(gap => gap.topic_id))
  const topics = recoverTopicIdentities(pending.manifest, { ...build, gaps })
  // 父链与成功子身份一同保留；正文仍从正常版本页读取。
  for (const topic of topics) if (ids.has(topic.id)) {
    let parent = topic.parent_id
    while (parent && !ids.has(parent)) { ids.add(parent); parent = topics.find(item => item.id === parent)?.parent_id ?? null }
  }
  pending.manifest.topic_recovery = { topics: topics.filter(topic => ids.has(topic.id)),
    repairs: Object.fromEntries(Object.entries(build.repairs ?? {}).filter(([id]) => ids.has(id))) }
}

export function restoreMissingTopics(state: TopicState, manifest: SnapshotManifest, pending?: PendingBuild['topics']): void {
  const known = new Set(state.topics.map(topic => topic.id))
  const wanted = new Set((pending?.gaps ?? manifest.topic_gaps ?? []).map(gap => gap.topic_id))
  for (const topic of recoverTopicIdentities(manifest, pending)) if (wanted.has(topic.id) && !known.has(topic.id)) {
    state.topics.push(topic); known.add(topic.id)
  }
}
