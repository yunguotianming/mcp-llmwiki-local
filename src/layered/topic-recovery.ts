import { topicPath } from './schema.js'
import type { BuildLayeredOptions, Extraction, PendingBuild, SnapshotManifest, Topic, TopicGap, TopicRepairState, TopicReviewWindowGrant, TopicReviewWindowRequest, TopicState } from './schema.js'
import { hash } from './files.js'

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

export function validateTopicRecoveryRequest(filter: BuildLayeredOptions['retryTopics'] | undefined): void {
  if (!filter) return
  if (filter.topicIds !== undefined && (!Array.isArray(filter.topicIds) || filter.topicIds.some(id => typeof id !== 'string' || !id.trim()))) throw new Error('主题恢复的 topicIds 必须是非空字符串数组。')
  if (filter.topicIds && new Set(filter.topicIds).size !== filter.topicIds.length) throw new Error('主题恢复的 topicIds 不得重复。')
  if (filter.reasons !== undefined && (!Array.isArray(filter.reasons) || filter.reasons.some(reason => typeof reason !== 'string' || !reason.trim()))) throw new Error('主题恢复的 reasons 必须是字符串数组。')
  if (filter.renewReviewWindow && (!filter.topicIds?.length)) throw new Error('renewReviewWindow 必须同时指定非空 topicIds。')
  if (filter.requestId !== undefined && (typeof filter.requestId !== 'string' || !filter.requestId.trim())) throw new Error('主题授时 requestId 不能为空。')
}

export interface TopicReviewWindowResult {
  requestId?: string
  granted: { topicId: string; originalDeadline: number; startedAt?: number; deadline?: number; rounds: number; totalRounds: number; maxRounds: number; regenerations: number }[]
  skipped: { topicId: string; reason: string }[]
}

const windowMinutes = 20 * 60 * 1000
const windowScope = (pending: PendingBuild) => pending.topic_scope ??= { targets: [], completed: [], review_inputs: {} }

export function registerTopicReviewWindowRequest(pending: PendingBuild, filter: NonNullable<BuildLayeredOptions['retryTopics']>, now = Date.now()): TopicReviewWindowResult {
  validateTopicRecoveryRequest(filter)
  if (!filter.renewReviewWindow) return { granted: [], skipped: [] }
  const ids = [...new Set(filter.topicIds!)]
  const scope = windowScope(pending), requestId = filter.requestId ?? hash(JSON.stringify(['topic-review-window-v1', pending.runId ?? pending.started_at, ids.sort(), [...(filter.reasons ?? [])].sort()]))
  const requests = scope.review_windows ??= {}, existing = requests[requestId]
  if (existing) return { requestId, granted: Object.values(existing.grants).filter(grant => grant.status !== 'skipped').map(grant => ({ topicId: grant.topic_id, originalDeadline: grant.original_deadline, ...(grant.started_at === undefined ? {} : { startedAt: grant.started_at }), ...(grant.deadline === undefined ? {} : { deadline: grant.deadline }), rounds: grant.rounds, totalRounds: grant.total_rounds, maxRounds: grant.max_rounds, regenerations: grant.regenerations })), skipped: Object.values(existing.grants).filter(grant => grant.status === 'skipped').map(grant => ({ topicId: grant.topic_id, reason: grant.reason ?? '未满足授时条件' })) }
  const request: TopicReviewWindowRequest = { request_id: requestId, targets: ids, created_at: now, grants: {} }
  const result: TopicReviewWindowResult = { requestId, granted: [], skipped: [] }
  for (const topicId of ids) {
    if (!scope.targets.includes(topicId) || scope.completed.includes(topicId)) {
      request.grants[topicId] = { topic_id: topicId, request_id: requestId, requested_at: now, input: '', evidence: '', member_ids: [], original_deadline: 0, status: 'skipped', reason: '目标未被当前恢复范围选中或已完成。', rounds: 0, total_rounds: 0, max_rounds: 0, regenerations: 0 }
      result.skipped.push({ topicId, reason: '目标未被当前恢复范围选中或已完成。' })
      continue
    }
    const repair = pending.topics?.repairs?.[topicId]
    const base = repair ? { topic_id: topicId, request_id: requestId, requested_at: now, input: repair.input, evidence: repair.evidence, member_ids: [...repair.member_ids], original_deadline: repair.deadline,
      rounds: repair.rounds, total_rounds: repair.total_rounds, max_rounds: repair.max_rounds, regenerations: repair.regenerations ?? 0 } : undefined
    if (!base) { request.grants[topicId] = { topic_id: topicId, request_id: requestId, requested_at: now, input: '', evidence: '', member_ids: [], original_deadline: 0, status: 'skipped', reason: '没有可续接的核对修复状态。', rounds: 0, total_rounds: 0, max_rounds: 0, regenerations: 0 }; result.skipped.push({ topicId, reason: '没有可续接的核对修复状态。' }); continue }
    if (base.original_deadline >= now) { request.grants[topicId] = { ...base, status: 'skipped', reason: '原核对期限尚未到期。' }; result.skipped.push({ topicId, reason: '原核对期限尚未到期。' }); continue }
    if (base.rounds >= base.max_rounds) { request.grants[topicId] = { ...base, status: 'skipped', reason: '主题核对轮次已达上限。' }; result.skipped.push({ topicId, reason: '主题核对轮次已达上限。' }); continue }
    const grant = { ...base, status: 'pending' as const }
    request.grants[topicId] = grant
    result.granted.push({ topicId, originalDeadline: grant.original_deadline, rounds: grant.rounds, totalRounds: grant.total_rounds, maxRounds: grant.max_rounds, regenerations: grant.regenerations })
  }
  requests[requestId] = request
  return result
}

export function consumeTopicReviewWindow(pending: PendingBuild, topicId: string, binding: { input: string; evidence: string; memberIds: string[]; content?: string }, now = Date.now()): TopicReviewWindowGrant | undefined {
  const requests = pending.topic_scope?.review_windows
  if (!requests) return undefined
  for (const request of Object.values(requests)) {
    const grant = request.grants[topicId]
    if (!grant) continue
    if (grant.status === 'consumed') return grant
    if (grant.status !== 'pending') continue
    const repair = pending.topics?.repairs?.[topicId]
    // 与核对续用修复稿的判定一致：证据须相同，输入摘要或修复稿正文二者之一相同。
    if (!repair || repair.evidence !== binding.evidence || repair.input !== binding.input && (binding.content === undefined || repair.content !== binding.content)
      || JSON.stringify([...repair.member_ids].sort()) !== JSON.stringify([...binding.memberIds].sort())) {
      grant.status = 'skipped'; grant.reason = '主题来源或核对证据绑定已变化，拒绝消费授时。'; return undefined
    }
    if (repair.deadline >= now) { grant.status = 'skipped'; grant.reason = '原核对期限尚未到期。'; return undefined }
    if (repair.rounds >= repair.max_rounds) { grant.status = 'skipped'; grant.reason = '主题核对轮次已达上限。'; return undefined }
    const startedAt = now, deadline = now + windowMinutes
    repair.deadline = deadline
    grant.status = 'consumed'; grant.started_at = startedAt; grant.deadline = deadline
    return grant
  }
  return undefined
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
